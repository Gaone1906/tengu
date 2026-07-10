import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PtyControlEvent,
  PtyIdleSpawnOpts,
  PtyInitialSnapshot,
  PtySnapshotSubscription,
  PtyViewEngine,
} from "../../engines/pty-view-engine.js";

vi.mock("../../sessions/registry.js", () => ({
  getSession: vi.fn(() => ({ id: "session-1", model: "model-1", effortLevel: "high" })),
  getEngineSessionRef: vi.fn(() => ({ id: "native-1" })),
}));

import { attachPtyWebSocket } from "../pty-ws.js";

class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent: Array<string | Buffer> = [];
  closed = false;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

function controls(ws: FakeWebSocket): any[] {
  return ws.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value));
}

class FakeEngine implements PtyViewEngine {
  warm = false;
  spawnCalls: PtyIdleSpawnOpts[] = [];
  restartCalls: PtyIdleSpawnOpts[] = [];
  viewingCalls: boolean[] = [];
  started = false;
  unsubscribed = false;
  onData?: (data: Buffer) => void;
  onControl?: (event: PtyControlEvent) => void;
  initial: PtyInitialSnapshot = {
    snapshot: { data: "persisted screen", cols: 90, rows: 30, visible: true },
    ready: true,
  };
  queuedOnStart: Buffer[] = [];

  hasWarmPty(): boolean { return this.warm; }
  ensureIdleSpawn(_sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.spawnCalls.push(opts);
    this.warm = true;
  }
  restartPty(_sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.restartCalls.push(opts);
    this.warm = true;
  }
  subscribeWithSnapshot(
    _sessionId: string,
    onData: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription {
    this.onData = onData;
    this.onControl = onControl;
    return {
      snapshot: Promise.resolve(this.initial),
      start: () => {
        this.started = true;
        for (const data of this.queuedOnStart.splice(0)) onData(data);
      },
      unsubscribe: () => { this.unsubscribed = true; },
    };
  }
  setViewing(_sessionId: string, viewing: boolean): void { this.viewingCalls.push(viewing); }
  writeStdin(): void {}
  writeRaw(): void {}
  resizePty(): void {}
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("attachPtyWebSocket snapshot framing", () => {
  beforeEach(() => vi.useRealTimers());

  it("sends reset, authoritative snapshot, ready, then ordered binary deltas", async () => {
    const ws = new FakeWebSocket();
    const engine = new FakeEngine();
    engine.queuedOnStart.push(Buffer.from("after-boundary"));

    attachPtyWebSocket(ws as any, "session-1", engine);
    await settle();

    expect(engine.started).toBe(true);
    expect(ws.sent.slice(0, 3).map((value) => JSON.parse(value.toString()).type)).toEqual([
      "reset",
      "snapshot",
      "ready",
    ]);
    expect(JSON.parse(ws.sent[1]!.toString()).snapshot.data).toBe("persisted screen");
    expect(ws.sent[3]).toEqual(Buffer.from("after-boundary"));
  });

  it("paints a persisted restart snapshot first but stays restoring until the new PTY is ready", async () => {
    const ws = new FakeWebSocket();
    const engine = new FakeEngine();
    engine.initial.ready = false;

    attachPtyWebSocket(ws as any, "session-1", engine);
    ws.receive({ type: "resize", cols: 100, rows: 40 });
    await settle();

    expect(controls(ws).slice(0, 3).map((event) => event.type)).toEqual([
      "reset",
      "snapshot",
      "restoring",
    ]);
    expect(controls(ws)[1].snapshot.data).toBe("persisted screen");
    expect(engine.spawnCalls).toEqual([expect.objectContaining({ cols: 100, rows: 40 })]);

    engine.onControl?.({ type: "reset" });
    engine.onControl?.({
      type: "snapshot",
      snapshot: { data: "new screen", cols: 100, rows: 40, visible: true },
    });
    engine.onControl?.({ type: "ready" });
    expect(controls(ws).slice(-3).map((event) => event.type)).toEqual(["reset", "snapshot", "ready"]);
  });

  it("reports a resume deadline and supports an explicit restart without blanking/closing", async () => {
    vi.useFakeTimers();
    const ws = new FakeWebSocket();
    const engine = new FakeEngine();
    engine.initial = { ready: false };

    attachPtyWebSocket(ws as any, "session-1", engine, { resumeDeadlineMs: 50 });
    await settle();
    ws.receive({ type: "resize", cols: 90, rows: 30 });
    await vi.advanceTimersByTimeAsync(50);

    expect(controls(ws).at(-1)).toEqual(expect.objectContaining({
      type: "error",
      recoverable: true,
    }));
    expect(ws.closed).toBe(false);

    ws.receive({ type: "restart" });
    expect(engine.restartCalls).toEqual([expect.objectContaining({ cols: 90, rows: 30 })]);
    expect(controls(ws).at(-1)).toEqual({ type: "restoring" });
  });

  it("cancels the resume deadline on ready and forwards explicit failures without closing", async () => {
    vi.useFakeTimers();
    const ws = new FakeWebSocket();
    const engine = new FakeEngine();
    engine.initial = { ready: false };

    attachPtyWebSocket(ws as any, "session-1", engine, { resumeDeadlineMs: 50 });
    await settle();
    ws.receive({ type: "resize", cols: 90, rows: 30 });
    engine.onControl?.({ type: "ready" });
    await vi.advanceTimersByTimeAsync(60);
    expect(controls(ws).filter((event) => event.type === "error")).toEqual([]);

    engine.onControl?.({ type: "error", message: "resume failed", recoverable: true });
    engine.onControl?.({ type: "exited", exitCode: 1, signal: 0 });
    expect(controls(ws).slice(-2)).toEqual([
      { type: "error", message: "resume failed", recoverable: true },
      { type: "exited", exitCode: 1, signal: 0 },
    ]);
    expect(ws.closed).toBe(false);
  });

  it("unsubscribes and clears timers when the socket disconnects", async () => {
    const ws = new FakeWebSocket();
    const engine = new FakeEngine();
    attachPtyWebSocket(ws as any, "session-1", engine);
    await settle();
    ws.close();
    expect(engine.unsubscribed).toBe(true);
  });

  it("re-applies active viewing state to the replacement lifecycle entry on restart", async () => {
    const ws = new FakeWebSocket();
    const engine = new FakeEngine();
    attachPtyWebSocket(ws as any, "session-1", engine);
    await settle();
    ws.receive({ type: "viewing", viewing: true });
    ws.receive({ type: "resize", cols: 90, rows: 30 });
    expect(engine.viewingCalls).toEqual([true]);

    ws.receive({ type: "restart" });
    expect(engine.viewingCalls).toEqual([true, true]);
  });
});
