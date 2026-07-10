import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PTY_SNAPSHOT_MAX_BYTES,
  PTY_SNAPSHOT_SCROLLBACK_LINES,
  PtySnapshot,
  PtySnapshotStore,
} from "../pty-snapshot.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

describe("PtySnapshot", () => {
  it("reconstructs the current viewport across colors, clears, cursor moves, and split escapes", async () => {
    const source = new PtySnapshot({ cols: 42, rows: 8 });
    await source.write("old screen\r\nline two");
    await source.write("\u001b[");
    await source.write("2J\u001b[H");
    await source.write("\u001b[31mred\u001b[0m\r\nsecond\r\nthird");
    await source.write("\u001b[2A\u001b[8C!");

    const serialized = await source.capture();
    const restored = new Terminal({ cols: serialized.cols, rows: serialized.rows, scrollback: 5000, allowProposedApi: true });
    await write(restored, serialized.data);

    expect(serialized.visible).toBe(true);
    expect(viewport(restored)).toEqual(source.viewport());
    source.dispose();
    restored.dispose();
  });

  it("keeps a 5,000-line session bounded by line and byte caps while preserving the viewport", async () => {
    const source = new PtySnapshot({ cols: 100, rows: 24 });
    const output = Array.from(
      { length: 5_200 },
      (_, i) => `line-${String(i).padStart(5, "0")} ${"x".repeat(90)}\r\n`,
    ).join("");
    await source.write(output);

    const serialized = await source.capture();
    const restored = new Terminal({ cols: serialized.cols, rows: serialized.rows, scrollback: 5000, allowProposedApi: true });
    await write(restored, serialized.data);

    expect(Buffer.byteLength(serialized.data, "utf8")).toBeLessThanOrEqual(PTY_SNAPSHOT_MAX_BYTES);
    expect(restored.buffer.active.length).toBeLessThanOrEqual(PTY_SNAPSHOT_SCROLLBACK_LINES + serialized.rows);
    expect(viewport(restored)).toEqual(source.viewport());
    source.dispose();
    restored.dispose();
  });

  it("does not call clear/cursor-only output a visible paint", async () => {
    const source = new PtySnapshot({ cols: 80, rows: 24 });
    await source.write("\u001b[2J\u001b[H\u001b[?25l");
    expect((await source.capture()).visible).toBe(false);
    await source.write("restored");
    expect((await source.capture()).visible).toBe(true);
    source.dispose();
  });

  it("never returns an empty ready snapshot when a color-dense viewport exceeds the byte cap", async () => {
    const source = new PtySnapshot({ cols: 500, rows: 250 });
    let output = "";
    for (let row = 0; row < 250; row += 1) {
      output += `\u001b[${row + 1};1H`;
      for (let col = 0; col < 500; col += 1) {
        output += `\u001b[38;2;${row % 256};${col % 256};${(row + col) % 256}mX`;
      }
    }
    await source.write(output);

    const serialized = await source.capture();

    expect(Buffer.byteLength(serialized.data, "utf8")).toBeLessThanOrEqual(PTY_SNAPSHOT_MAX_BYTES);
    expect(serialized.visible).toBe(true);
    expect(serialized.data.length).toBeGreaterThan(0);
    const restored = new Terminal({ cols: 500, rows: 250, scrollback: 5000, allowProposedApi: true });
    await write(restored, serialized.data);
    expect(viewport(restored)).toEqual(source.viewport());
    source.dispose();
    restored.dispose();
  });
});

describe("PtySnapshotStore", () => {
  it("rejects a persisted empty snapshot that claims to be visible", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pty-snapshot-empty-ready-"));
    tempDirs.push(dir);
    const store = new PtySnapshotStore(dir, { debounceMs: 0 });

    store.schedule("invalid-empty-ready", { data: "", cols: 80, rows: 24, visible: true });
    await store.flush("invalid-empty-ready");

    expect(await store.load("invalid-empty-ready")).toBeUndefined();
  });

  it("atomically persists, reloads, and deletes a versioned session snapshot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pty-snapshot-"));
    tempDirs.push(dir);
    const store = new PtySnapshotStore(dir, { debounceMs: 5 });
    const snapshot = {
      data: "\u001b[32mrestored terminal\u001b[0m",
      cols: 90,
      rows: 30,
      visible: true,
    };

    store.schedule("session/with unsafe chars", snapshot);
    await store.flush("session/with unsafe chars");

    expect(await store.load("session/with unsafe chars")).toEqual(snapshot);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(fs.readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(false);

    await store.delete("session/with unsafe chars");
    expect(await store.load("session/with unsafe chars")).toBeUndefined();
  });

  it("cannot recreate a deleted snapshot from an in-flight atomic rename", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pty-snapshot-delete-race-"));
    tempDirs.push(dir);
    const store = new PtySnapshotStore(dir, { debounceMs: 0 });
    const originalRename = fs.promises.rename.bind(fs.promises);
    let releaseRename!: () => void;
    let markRenameStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRename = resolve; });
    const renameStarted = new Promise<void>((resolve) => { markRenameStarted = resolve; });
    const rename = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      markRenameStarted();
      await gate;
      return originalRename(from, to);
    });

    store.schedule("deleted-during-write", { data: "stale", cols: 80, rows: 24, visible: true });
    await renameStarted;
    const writing = (store as unknown as {
      pending: Map<string, { writing: Promise<void> }>;
    }).pending.get("deleted-during-write")!.writing;
    store.deleteSync("deleted-during-write");
    releaseRename();
    await writing;

    expect(await store.load("deleted-during-write")).toBeUndefined();
    rename.mockRestore();
  });

  it("releases completed debounce bookkeeping after a flush", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pty-snapshot-bookkeeping-"));
    tempDirs.push(dir);
    const store = new PtySnapshotStore(dir, { debounceMs: 0 });

    store.schedule("finished", { data: "screen", cols: 80, rows: 24, visible: true });
    await store.flush("finished");

    const pending = (store as unknown as { pending: Map<string, unknown> }).pending;
    expect(pending.size).toBe(0);
  });
});
