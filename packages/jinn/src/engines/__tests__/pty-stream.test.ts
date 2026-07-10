import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { PtySnapshotStore } from "../pty-snapshot.js";
import { PtyStreamManager, createPtyHandle, setCapped, STREAM_MAP_CAP } from "../pty-stream.js";
import type { PtyControlEvent } from "../pty-view-engine.js";

const tempDirs: string[] = [];

afterEach(async () => {
  // Readiness schedules a final capture after 75ms. Let that unref'd timer and
  // the store's 1ms atomic write settle before removing its temporary home.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
});

/** Minimal fake IPty: lets the test drive onData/onExit and inspect handlers. */
function makeFakePty(cols = 80, rows = 24) {
  let dataCb: ((d: string) => void) | undefined;
  let errorCb: ((e: Error) => void) | undefined;
  const proc: any = {
    pid: 4242,
    cols,
    rows,
    _exitCode: null as number | null,
    _killedWith: undefined as string | undefined,
    onData: (cb: (d: string) => void) => { dataCb = cb; },
    onExit: () => {},
    on: (event: string, cb: (e: Error) => void) => { if (event === "error") errorCb = cb; },
    kill: (sig?: string) => { proc._killedWith = sig ?? "SIGTERM"; },
    emitData: (d: string) => dataCb?.(d),
    emitError: (e: Error) => errorCb?.(e),
  };
  return proc;
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pty-stream-"));
  tempDirs.push(dir);
  return new PtySnapshotStore(dir, { debounceMs: 1 });
}

function makeManager(store = makeStore(), hasWarm: (id: string) => boolean = () => true) {
  return new PtyStreamManager("Test PTY", hasWarm, { snapshotStore: store });
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function viewport(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const first = buffer.baseY;
  return Array.from({ length: term.rows }, (_, offset) =>
    buffer.getLine(first + offset)?.translateToString(true) ?? "",
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("PtyStreamManager snapshot subscriptions", () => {
  it("captures an atomic snapshot boundary and releases later bytes in exact order", async () => {
    const manager = makeManager();
    const proc = makeFakePty(40, 8);
    manager.attach("s1", proc);
    proc.emitData("before\r\n");
    await settle();

    const deltas: Buffer[] = [];
    const controls: PtyControlEvent[] = [];
    const subscription = manager.subscribeWithSnapshot(
      "s1",
      (data) => deltas.push(data),
      (event) => controls.push(event),
    );
    proc.emitData("after-a\r\n");
    proc.emitData("after-b");

    const initial = await subscription.snapshot;
    expect(initial.ready).toBe(true);
    expect(deltas).toEqual([]);
    subscription.start();
    expect(Buffer.concat(deltas).toString("utf8")).toBe("after-a\r\nafter-b");

    const restored = new Terminal({
      cols: initial.snapshot!.cols,
      rows: initial.snapshot!.rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    await write(restored, initial.snapshot!.data);
    await write(restored, Buffer.concat(deltas).toString("utf8"));

    const expected = new Terminal({ cols: 40, rows: 8, scrollback: 5000, allowProposedApi: true });
    await write(expected, "before\r\nafter-a\r\nafter-b");
    expect(viewport(restored)).toEqual(viewport(expected));
    expect(controls).toEqual([]);
    subscription.unsubscribe();
    restored.dispose();
    expected.dispose();
  });

  it("keeps the last good screen during respawn and replaces it only after a visible first paint", async () => {
    const manager = makeManager();
    const first = makeFakePty();
    manager.attach("s1", first);
    first.emitData("last good screen");
    await settle();

    const controls: PtyControlEvent[] = [];
    const sub = manager.subscribeWithSnapshot("s1", () => {}, (event) => controls.push(event));
    expect((await sub.snapshot).ready).toBe(true);
    sub.start();

    const second = makeFakePty();
    manager.attach("s1", second);
    expect(controls.map((event) => event.type)).toEqual(["restoring"]);
    second.emitData("\u001b[2J\u001b[H\u001b[?25l");
    await settle();
    expect(controls.map((event) => event.type)).toEqual(["restoring"]);

    second.emitData("new screen");
    await settle();
    expect(controls.map((event) => event.type)).toEqual([
      "restoring",
      "reset",
      "snapshot",
      "ready",
    ]);
    const snapshotEvent = controls.find((event) => event.type === "snapshot");
    expect(snapshotEvent?.type === "snapshot" && snapshotEvent.snapshot.data).toContain("new screen");
    sub.unsubscribe();
  });

  it("captures the final pre-respawn bytes into the stale screen shown while restoring", async () => {
    const manager = makeManager();
    const first = makeFakePty();
    manager.attach("s1", first);
    first.emitData("initial");
    await settle();
    first.emitData(" latest-before-respawn");
    manager.attach("s1", makeFakePty());

    const sub = manager.subscribeWithSnapshot("s1", () => {});
    const initial = await sub.snapshot;
    expect(initial.ready).toBe(false);
    expect(initial.snapshot?.data).toContain("latest-before-respawn");
    sub.unsubscribe();
  });

  it("persists a bounded screen and restores it before any new PTY exists after gateway restart", async () => {
    const store = makeStore();
    const firstManager = makeManager(store);
    const proc = makeFakePty();
    firstManager.attach("long-session", proc);
    proc.emitData(Array.from({ length: 5_100 }, (_, i) => `line-${i}\r\n`).join(""));
    await firstManager.flushSnapshot("long-session");

    const restartedManager = makeManager(store, () => false);
    const sub = restartedManager.subscribeWithSnapshot("long-session", () => {});
    const initial = await sub.snapshot;

    expect(initial.ready).toBe(false);
    expect(initial.snapshot?.visible).toBe(true);
    expect(initial.snapshot?.data).toContain("line-5099");
    sub.unsubscribe();
  });

  it("retains the last good snapshot on exit and emits explicit exited/error controls", async () => {
    const manager = makeManager();
    const proc = makeFakePty();
    manager.attach("s1", proc);
    proc.emitData("useful screen");
    await settle();

    const controls: PtyControlEvent[] = [];
    const sub = manager.subscribeWithSnapshot("s1", () => {}, (event) => controls.push(event));
    sub.start();
    await sub.snapshot;
    manager.onPtyExit("s1", { exitCode: 1, signal: 0 });
    manager.reportError("s1", "resume failed");

    expect(controls).toContainEqual({ type: "exited", exitCode: 1, signal: 0 });
    expect(controls).toContainEqual({ type: "error", message: "resume failed", recoverable: true });
    const reconnect = manager.subscribeWithSnapshot("s1", () => {});
    expect((await reconnect.snapshot).snapshot?.data).toContain("useful screen");
    sub.unsubscribe();
    reconnect.unsubscribe();
  });

  it("does not duplicate content across repeated reconnect snapshots", async () => {
    const manager = makeManager();
    const proc = makeFakePty();
    manager.attach("s1", proc);
    proc.emitData("one\r\ntwo");
    await settle();

    for (let i = 0; i < 4; i += 1) {
      const deltas: Buffer[] = [];
      const sub = manager.subscribeWithSnapshot("s1", (data) => deltas.push(data));
      const initial = await sub.snapshot;
      sub.start();
      expect(deltas).toEqual([]);
      expect(initial.snapshot?.data.match(/one/g)).toHaveLength(1);
      sub.unsubscribe();
    }
  });

  it("calls the onData hook and absorbs node-pty socket errors", () => {
    const manager = makeManager();
    const proc = makeFakePty();
    let hits = 0;
    manager.attach("s1", proc, () => { hits += 1; });
    proc.emitData("a");
    proc.emitData("b");
    expect(hits).toBe(2);
    expect(() => proc.emitError(new Error("EIO"))).not.toThrow();
  });

  it("bounds stalled pre-ready control output while preserving the eventual authoritative paint", async () => {
    const manager = makeManager();
    const proc = makeFakePty(80, 24);
    manager.attach("stalled", proc);
    const deltas: Buffer[] = [];
    const controls: PtyControlEvent[] = [];
    const sub = manager.subscribeWithSnapshot(
      "stalled",
      (data) => deltas.push(data),
      (event) => controls.push(event),
    );
    expect((await sub.snapshot).ready).toBe(false);
    sub.start();

    const controlOnly = "\u001b[H";
    for (let i = 0; i < 2_100; i += 1) proc.emitData(controlOnly);

    const entry = (manager as unknown as {
      streams: Map<string, { pendingGeneration: Array<{ data: Buffer }> }>;
    }).streams.get("stalled")!;
    expect(entry.pendingGeneration.length).toBeLessThanOrEqual(2_048);

    const largeControlOnly = `\u001b]0;${"x".repeat(16 * 1_024)}\u0007`;
    for (let i = 0; i < 33; i += 1) proc.emitData(largeControlOnly);
    expect(entry.pendingGeneration.reduce((bytes, chunk) => bytes + chunk.data.byteLength, 0))
      .toBeLessThanOrEqual(512 * 1024);

    proc.emitData("authoritative paint");
    proc.emitData(" + ordered tail");
    await manager.flushSnapshot("stalled");
    await settle();

    const snapshot = controls.find((event) => event.type === "snapshot");
    expect(snapshot?.type).toBe("snapshot");
    expect(controls.at(-1)?.type).toBe("ready");
    const restored = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    if (snapshot?.type === "snapshot") await write(restored, snapshot.snapshot.data);
    await write(restored, Buffer.concat(deltas).toString("utf8"));
    expect(viewport(restored).join("\n")).toContain("authoritative paint + ordered tail");
    restored.dispose();
    sub.unsubscribe();
  }, 30_000);

  it("caps stream bookkeeping and preserves recently touched sessions", async () => {
    const manager = makeManager();
    for (let i = 0; i < STREAM_MAP_CAP + 2; i += 1) {
      const proc = makeFakePty();
      manager.attach(`s${i}`, proc);
      proc.emitData(`data-${i}`);
    }
    await settle();
    const old = manager.subscribeWithSnapshot("s0", () => {});
    const recent = manager.subscribeWithSnapshot(`s${STREAM_MAP_CAP + 1}`, () => {});
    expect((await old.snapshot).snapshot).toBeUndefined();
    expect((await recent.snapshot).snapshot?.data).toContain(`data-${STREAM_MAP_CAP + 1}`);
    old.unsubscribe();
    recent.unsubscribe();
  });
});

describe("createPtyHandle", () => {
  it("exposes pid/killed/kill and stashes the proc on _proc", () => {
    const proc = makeFakePty();
    const handle = createPtyHandle(proc);
    expect(handle.pid).toBe(4242);
    expect(handle.killed).toBe(false);
    proc._exitCode = 0;
    expect(handle.killed).toBe(true);
    handle.kill("SIGTERM");
    expect(proc._killedWith).toBe("SIGTERM");
    expect((handle as any)._proc).toBe(proc);
  });
});

describe("setCapped", () => {
  it("evicts the oldest-touched entry and refreshes existing recency", () => {
    const map = new Map<string, number>();
    setCapped(map, "a", 1, 2);
    setCapped(map, "b", 2, 2);
    setCapped(map, "a", 10, 2);
    setCapped(map, "c", 3, 2);
    expect([...map.keys()]).toEqual(["a", "c"]);
    expect(map.get("a")).toBe(10);
  });
});
