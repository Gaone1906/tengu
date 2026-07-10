import * as pty from "node-pty";
import { logger } from "../shared/logger.js";
import {
  PtySnapshot,
  PtySnapshotStore,
  ptySnapshotStore,
  type SerializedPtySnapshot,
} from "./pty-snapshot.js";
import type {
  PtyControlEvent,
  PtyInitialSnapshot,
  PtySnapshotSubscription,
} from "./pty-view-engine.js";
import type { PtyHandle } from "./pty-lifecycle.js";

/** Cap for small per-session bookkeeping maps that must survive PTY respawns. */
export const SESSION_MAP_CAP = 512;
/** Bound live headless terminal instances in the long-running gateway. */
export const STREAM_MAP_CAP = 128;
const PENDING_GENERATION_MAX_CHUNKS = 2_048;
const PENDING_GENERATION_MAX_BYTES = 512 * 1024;

export function setCapped<V>(map: Map<string, V>, key: string, value: V, cap = SESSION_MAP_CAP): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

type QueuedSubscriberEvent =
  | { kind: "data"; data: Buffer }
  | { kind: "control"; event: PtyControlEvent };

interface Subscriber {
  data: (data: Buffer) => void;
  control?: (event: PtyControlEvent) => void;
  started: boolean;
  queue: QueuedSubscriberEvent[];
}

interface SequencedChunk {
  sequence: number;
  data: Buffer;
}

interface StreamEntry {
  subscribers: Set<Subscriber>;
  hasSeenPty: boolean;
  generation: number;
  generationReady: boolean;
  sequence: number;
  snapshot?: PtySnapshot;
  lastGood?: SerializedPtySnapshot;
  loadPromise: Promise<void>;
  fallbackPromise: Promise<void>;
  pendingGeneration: SequencedChunk[];
  pendingGenerationBytes: number;
  pendingGenerationDroppedThrough: number;
  checkingReadiness: boolean;
  captureTimer?: ReturnType<typeof setTimeout>;
}

interface PtyStreamManagerOptions {
  snapshotStore?: PtySnapshotStore;
}

/**
 * Per-session terminal state shared by interactive engines. A real headless
 * xterm replaces the old raw byte tail, and subscribers pause at an exact
 * sequence boundary until their authoritative snapshot has been framed.
 */
export class PtyStreamManager {
  private readonly streams = new Map<string, StreamEntry>();
  private readonly snapshotStore: PtySnapshotStore;

  constructor(
    private readonly label: string,
    private readonly hasWarmPty: (sessionId: string) => boolean,
    options: PtyStreamManagerOptions = {},
  ) {
    this.snapshotStore = options.snapshotStore ?? ptySnapshotStore;
  }

  attach(sessionId: string, proc: pty.IPty, onData?: () => void): void {
    const stream = this.streamFor(sessionId);
    const respawn = stream.hasSeenPty;
    stream.hasSeenPty = true;
    stream.generation += 1;
    stream.generationReady = false;
    stream.pendingGeneration = [];
    stream.pendingGenerationBytes = 0;
    stream.pendingGenerationDroppedThrough = 0;
    stream.checkingReadiness = false;
    if (stream.captureTimer) clearTimeout(stream.captureTimer);

    const previous = stream.snapshot;
    if (previous) {
      const priorFallback = stream.fallbackPromise;
      stream.fallbackPromise = (async () => {
        await priorFallback;
        const captured = await previous.captureAtBoundary();
        if (captured.visible) {
          stream.lastGood = captured;
          this.snapshotStore.schedule(sessionId, captured);
        }
      })().catch(() => undefined).finally(() => previous.dispose());
    }
    stream.snapshot = new PtySnapshot({
      cols: positiveInt((proc as { cols?: number }).cols, 120),
      rows: positiveInt((proc as { rows?: number }).rows, 40),
    });
    if (respawn || stream.subscribers.size > 0) this.emitControl(stream, { type: "restoring" });

    (proc as any).on?.("error", (error: Error) => {
      logger.warn(`${this.label} socket error for session ${sessionId}: ${error.message}`);
    });

    proc.onData((raw) => {
      onData?.();
      const current = this.streams.get(sessionId);
      if (current !== stream || !stream.snapshot) return;
      const data = Buffer.from(raw, "utf8");
      const sequence = ++stream.sequence;
      stream.snapshot.write(data).catch((error) => this.reportError(
        sessionId,
        `terminal snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      ));

      if (stream.generationReady) {
        this.emitData(stream, data);
        this.scheduleCapture(sessionId, stream);
      } else {
        this.queuePendingGeneration(stream, { sequence, data });
        this.checkReadiness(sessionId, stream, stream.generation);
      }
    });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const stream = this.streams.get(sessionId);
    if (!stream?.snapshot) return;
    void stream.snapshot.resize(cols, rows).then(() => {
      if (stream.generationReady) this.scheduleCapture(sessionId, stream);
    });
  }

  subscribeWithSnapshot(
    sessionId: string,
    data: (chunk: Buffer) => void,
    control?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription {
    const stream = this.streamFor(sessionId);
    const subscriber: Subscriber = { data, control, started: false, queue: [] };
    stream.subscribers.add(subscriber);

    // Capture both decisions synchronously. Later PTY bytes are queued on the
    // paused subscriber and cannot move this boundary.
    const boundaryReady = stream.generationReady && this.hasWarmPty(sessionId);
    const boundarySnapshot = boundaryReady && stream.snapshot
      ? stream.snapshot.captureAtBoundary()
      : undefined;
    const snapshot = (async (): Promise<PtyInitialSnapshot> => {
      await stream.loadPromise;
      await stream.fallbackPromise;
      const captured = boundarySnapshot ? await boundarySnapshot : stream.lastGood;
      return { snapshot: captured, ready: boundaryReady && captured?.visible === true };
    })();

    let unsubscribed = false;
    const unsubscribe = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      stream.subscribers.delete(subscriber);
      subscriber.queue = [];
    };
    return {
      snapshot,
      start: () => {
        if (unsubscribed || subscriber.started) return;
        subscriber.started = true;
        const queued = subscriber.queue;
        subscriber.queue = [];
        for (const event of queued) this.deliver(subscriber, event);
      },
      unsubscribe,
    };
  }

  onPtyExit(sessionId: string, event: { exitCode: number; signal?: number }): void {
    const stream = this.streams.get(sessionId);
    if (!stream) return;
    if (stream.captureTimer) clearTimeout(stream.captureTimer);
    const snapshot = stream.snapshot;
    if (snapshot) {
      stream.fallbackPromise = snapshot.captureAtBoundary().then((captured) => {
        if (!captured.visible) return;
        stream.lastGood = captured;
        this.snapshotStore.schedule(sessionId, captured);
      }).catch(() => undefined);
    }
    stream.generationReady = false;
    stream.pendingGeneration = [];
    stream.pendingGenerationBytes = 0;
    stream.pendingGenerationDroppedThrough = 0;
    this.emitControl(stream, { type: "exited", exitCode: event.exitCode, signal: event.signal ?? 0 });
  }

  reportError(sessionId: string, message: string): void {
    const stream = this.streamFor(sessionId);
    this.emitControl(stream, { type: "error", message, recoverable: true });
  }

  async flushSnapshot(sessionId: string): Promise<void> {
    const stream = this.streams.get(sessionId);
    if (stream?.snapshot) {
      const captured = await stream.snapshot.captureAtBoundary();
      if (captured.visible) {
        stream.lastGood = captured;
        this.snapshotStore.schedule(sessionId, captured);
      }
    }
    await this.snapshotStore.flush(sessionId);
  }

  private checkReadiness(sessionId: string, stream: StreamEntry, generation: number): void {
    if (stream.checkingReadiness || !stream.snapshot) return;
    stream.checkingReadiness = true;
    const boundarySequence = stream.sequence;
    const capture = stream.snapshot.captureAtBoundary();
    void capture.then((snapshot) => {
      if (this.streams.get(sessionId) !== stream || stream.generation !== generation) return;
      stream.checkingReadiness = false;
      if (!snapshot.visible) {
        if (stream.sequence > boundarySequence) this.checkReadiness(sessionId, stream, generation);
        return;
      }

      // If the bounded queue evicted bytes newer than this capture boundary,
      // recapture at the latest head. Otherwise reset+snapshot would omit the
      // dropped mutation before releasing the remaining deltas.
      if (stream.pendingGenerationDroppedThrough > boundarySequence) {
        this.checkReadiness(sessionId, stream, generation);
        return;
      }

      stream.generationReady = true;
      stream.lastGood = snapshot;
      this.snapshotStore.schedule(sessionId, snapshot);
      this.emitControl(stream, { type: "reset" });
      this.emitControl(stream, { type: "snapshot", snapshot });
      this.emitControl(stream, { type: "ready" });

      const later = stream.pendingGeneration.filter((item) => item.sequence > boundarySequence);
      stream.pendingGeneration = [];
      stream.pendingGenerationBytes = 0;
      stream.pendingGenerationDroppedThrough = 0;
      for (const item of later) this.emitData(stream, item.data);
      this.scheduleCapture(sessionId, stream);
    }).catch((error) => {
      stream.checkingReadiness = false;
      this.reportError(sessionId, `terminal snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private scheduleCapture(sessionId: string, stream: StreamEntry): void {
    if (stream.captureTimer) clearTimeout(stream.captureTimer);
    stream.captureTimer = setTimeout(() => {
      stream.captureTimer = undefined;
      const snapshot = stream.snapshot;
      if (!snapshot || !stream.generationReady) return;
      void snapshot.captureAtBoundary().then((captured) => {
        if (!captured.visible || this.streams.get(sessionId) !== stream) return;
        stream.lastGood = captured;
        this.snapshotStore.schedule(sessionId, captured);
      }).catch(() => undefined);
    }, 75);
    stream.captureTimer.unref?.();
  }

  private queuePendingGeneration(stream: StreamEntry, chunk: SequencedChunk): void {
    stream.pendingGeneration.push(chunk);
    stream.pendingGenerationBytes += chunk.data.byteLength;
    while (
      stream.pendingGeneration.length > PENDING_GENERATION_MAX_CHUNKS
      || stream.pendingGenerationBytes > PENDING_GENERATION_MAX_BYTES
    ) {
      const dropped = stream.pendingGeneration.shift();
      if (!dropped) break;
      stream.pendingGenerationBytes -= dropped.data.byteLength;
      stream.pendingGenerationDroppedThrough = dropped.sequence;
    }
  }

  private emitData(stream: StreamEntry, data: Buffer): void {
    for (const subscriber of stream.subscribers) {
      const event: QueuedSubscriberEvent = { kind: "data", data };
      if (subscriber.started) this.deliver(subscriber, event);
      else subscriber.queue.push(event);
    }
  }

  private emitControl(stream: StreamEntry, event: PtyControlEvent): void {
    for (const subscriber of stream.subscribers) {
      const queued: QueuedSubscriberEvent = { kind: "control", event };
      if (subscriber.started) this.deliver(subscriber, queued);
      else subscriber.queue.push(queued);
    }
  }

  private deliver(subscriber: Subscriber, event: QueuedSubscriberEvent): void {
    try {
      if (event.kind === "data") subscriber.data(event.data);
      else subscriber.control?.(event.event);
    } catch { /* isolate subscriber failures */ }
  }

  private streamFor(sessionId: string): StreamEntry {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = {
        subscribers: new Set(),
        hasSeenPty: false,
        generation: 0,
        generationReady: false,
        sequence: 0,
        loadPromise: Promise.resolve(),
        fallbackPromise: Promise.resolve(),
        pendingGeneration: [],
        pendingGenerationBytes: 0,
        pendingGenerationDroppedThrough: 0,
        checkingReadiness: false,
      };
      const created = stream;
      created.loadPromise = this.snapshotStore.load(sessionId).then((snapshot) => {
        if (snapshot && !created.lastGood) created.lastGood = snapshot;
      });
    }

    if (this.streams.has(sessionId)) this.streams.delete(sessionId);
    this.streams.set(sessionId, stream);
    while (this.streams.size > STREAM_MAP_CAP) {
      const oldestId = this.streams.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      const oldest = this.streams.get(oldestId);
      if (oldest?.captureTimer) clearTimeout(oldest.captureTimer);
      const evictedSnapshot = oldest?.snapshot;
      if (evictedSnapshot) {
        void evictedSnapshot.captureAtBoundary().finally(() => evictedSnapshot.dispose());
      }
      this.streams.delete(oldestId);
    }
    return stream;
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

export function createPtyHandle(proc: pty.IPty): PtyHandle {
  const handle = {
    pid: proc.pid,
    get killed() { return (proc as any)._exitCode != null; },
    kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
  } as PtyHandle;
  (handle as any)._proc = proc;
  return handle;
}
