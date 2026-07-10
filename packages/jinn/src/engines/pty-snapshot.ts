import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { PTY_SNAPSHOTS_DIR } from "../shared/paths.js";

export const PTY_SNAPSHOT_SCROLLBACK_LINES = 1_500;
export const PTY_SNAPSHOT_MAX_BYTES = 512 * 1024;
const SNAPSHOT_VERSION = 1;

export interface SerializedPtySnapshot {
  data: string;
  cols: number;
  rows: number;
  visible: boolean;
}

interface PersistedPtySnapshot extends SerializedPtySnapshot {
  version: typeof SNAPSHOT_VERSION;
}

interface PtySnapshotOptions {
  cols: number;
  rows: number;
  initial?: SerializedPtySnapshot;
}

/**
 * A server-side terminal emulator fed from the same byte stream as the browser.
 * Writes are explicitly serialized so split escape sequences and snapshot
 * boundaries retain the PTY's exact order.
 */
export class PtySnapshot {
  private readonly terminal: Terminal;
  private readonly serializeAddon: SerializeAddon;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: PtySnapshotOptions) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: PTY_SNAPSHOT_SCROLLBACK_LINES,
      convertEol: true,
      // Buffer inspection is a proposed headless API in xterm 6. Snapshot
      // visibility and bounded scrollback need read-only access to it.
      allowProposedApi: true,
    });
    this.serializeAddon = new SerializeAddon();
    // The browser and headless Terminal addon contracts are structurally
    // identical, but addon-serialize's declarations name @xterm/xterm.
    this.terminal.loadAddon(this.serializeAddon as never);
    if (options.initial?.data) {
      this.pending = this.writeQueued(options.initial.data);
    }
  }

  write(data: string | Buffer): Promise<void> {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    this.pending = this.pending.then(() => this.writeQueued(text));
    return this.pending;
  }

  resize(cols: number, rows: number): Promise<void> {
    this.pending = this.pending.then(() => {
      this.terminal.resize(cols, rows);
    });
    return this.pending;
  }

  async capture(): Promise<SerializedPtySnapshot> {
    return this.captureAtBoundary();
  }

  /** Capture exactly through the writes queued when this method is called. */
  captureAtBoundary(): Promise<SerializedPtySnapshot> {
    const boundary = this.pending;
    return boundary.then(() => this.captureNow());
  }

  private captureNow(): SerializedPtySnapshot {
    let low = 0;
    let high = Math.min(PTY_SNAPSHOT_SCROLLBACK_LINES, this.terminal.buffer.active.baseY);
    let data = this.serializeAddon.serialize({ scrollback: high });

    if (Buffer.byteLength(data, "utf8") > PTY_SNAPSHOT_MAX_BYTES) {
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const candidate = this.serializeAddon.serialize({ scrollback: mid });
        if (Buffer.byteLength(candidate, "utf8") <= PTY_SNAPSHOT_MAX_BYTES) low = mid;
        else high = mid - 1;
      }
      data = this.serializeAddon.serialize({ scrollback: low });
    }

    // The viewport is bounded by the validated PTY geometry. If a future xterm
    // release produces more than the hard cap even with zero scrollback, fail
    // closed to an empty snapshot rather than persist a truncated ANSI suffix.
    if (Buffer.byteLength(data, "utf8") > PTY_SNAPSHOT_MAX_BYTES) data = "";

    return {
      data,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      visible: this.hasVisibleContent(),
    };
  }

  viewport(): string[] {
    const buffer = this.terminal.buffer.active;
    const first = buffer.baseY;
    return Array.from({ length: this.terminal.rows }, (_, offset) =>
      buffer.getLine(first + offset)?.translateToString(true) ?? "",
    );
  }

  dispose(): void {
    this.serializeAddon.dispose();
    this.terminal.dispose();
  }

  private writeQueued(data: string): Promise<void> {
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }

  private hasVisibleContent(): boolean {
    const buffer = this.terminal.buffer.active;
    for (let i = 0; i < buffer.length; i += 1) {
      if ((buffer.getLine(i)?.translateToString(true) ?? "").length > 0) return true;
    }
    return false;
  }
}

interface StoreOptions {
  debounceMs?: number;
}

interface PendingWrite {
  snapshot: SerializedPtySnapshot;
  timer?: ReturnType<typeof setTimeout>;
  writing: Promise<void>;
}

/** Debounced, atomic, per-session persistence for the last good PTY snapshot. */
export class PtySnapshotStore {
  private readonly debounceMs: number;
  private readonly pending = new Map<string, PendingWrite>();
  private readonly epochs = new Map<string, number>();

  constructor(
    private readonly directory = PTY_SNAPSHOTS_DIR,
    options: StoreOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 150;
  }

  async load(sessionId: string): Promise<SerializedPtySnapshot | undefined> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.fileFor(sessionId), "utf8")) as Partial<PersistedPtySnapshot>;
      if (
        parsed.version !== SNAPSHOT_VERSION
        || typeof parsed.data !== "string"
        || typeof parsed.cols !== "number"
        || typeof parsed.rows !== "number"
        || typeof parsed.visible !== "boolean"
        || !Number.isInteger(parsed.cols)
        || !Number.isInteger(parsed.rows)
        || parsed.cols < 1
        || parsed.rows < 1
        || parsed.cols > 500
        || parsed.rows > 250
        || Buffer.byteLength(parsed.data, "utf8") > PTY_SNAPSHOT_MAX_BYTES
      ) return undefined;
      return { data: parsed.data, cols: parsed.cols, rows: parsed.rows, visible: parsed.visible };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  schedule(sessionId: string, snapshot: SerializedPtySnapshot): void {
    const existing = this.pending.get(sessionId);
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: PendingWrite = existing ?? { snapshot, writing: Promise.resolve() };
    entry.snapshot = { ...snapshot };
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      const scheduled = { ...entry.snapshot };
      const epoch = this.epoch(sessionId);
      this.queueWrite(sessionId, entry, scheduled, epoch);
    }, this.debounceMs);
    entry.timer.unref?.();
    this.pending.set(sessionId, entry);
  }

  async flush(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      const scheduled = { ...entry.snapshot };
      const epoch = this.epoch(sessionId);
      this.queueWrite(sessionId, entry, scheduled, epoch);
    }
    await entry.writing;
  }

  async delete(sessionId: string): Promise<void> {
    const deletionEpoch = this.epoch(sessionId) + 1;
    this.epochs.set(sessionId, deletionEpoch);
    const entry = this.pending.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry) await entry.writing.catch(() => undefined);
    this.pending.delete(sessionId);
    await fs.promises.rm(this.fileFor(sessionId), { force: true });
    if (this.epoch(sessionId) === deletionEpoch) this.epochs.delete(sessionId);
  }

  deleteSync(sessionId: string): void {
    const deletionEpoch = this.epoch(sessionId) + 1;
    this.epochs.set(sessionId, deletionEpoch);
    const entry = this.pending.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    try { fs.rmSync(this.fileFor(sessionId), { force: true }); } catch { /* best effort */ }
    if (entry) {
      void entry.writing.then(
        () => { if (this.epoch(sessionId) === deletionEpoch) this.epochs.delete(sessionId); },
        () => { if (this.epoch(sessionId) === deletionEpoch) this.epochs.delete(sessionId); },
      );
    } else {
      this.epochs.delete(sessionId);
    }
  }

  private queueWrite(
    sessionId: string,
    entry: PendingWrite,
    snapshot: SerializedPtySnapshot,
    epoch: number,
  ): void {
    const writing = entry.writing
      .then(() => this.writeAtomic(sessionId, snapshot, epoch))
      .catch(() => undefined);
    entry.writing = writing;
    void writing.then(() => {
      if (this.pending.get(sessionId) === entry && !entry.timer && entry.writing === writing) {
        this.pending.delete(sessionId);
      }
    });
  }

  private async writeAtomic(sessionId: string, snapshot: SerializedPtySnapshot, epoch: number): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.fileFor(sessionId);
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    const payload: PersistedPtySnapshot = { version: SNAPSHOT_VERSION, ...snapshot };
    try {
      await fs.promises.writeFile(temp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      if (this.epoch(sessionId) !== epoch) return;
      await fs.promises.rename(temp, target);
      if (this.epoch(sessionId) !== epoch) await fs.promises.rm(target, { force: true });
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private fileFor(sessionId: string): string {
    const key = createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.directory, `${key}.json`);
  }

  private epoch(sessionId: string): number {
    return this.epochs.get(sessionId) ?? 0;
  }
}

export const ptySnapshotStore = new PtySnapshotStore();
