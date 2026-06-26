/**
 * PTY lifecycle for interactive CLI/xterm engines.
 *
 * Rules:
 *   - A PTY is not reaped because it is old. Native agent loops can legitimately
 *     sit idle for days and wake themselves later.
 *   - maxLivePtys is an IDLE warm-PTY cap. Running turns and actively viewed
 *     terminals are never counted against it or killed to satisfy it.
 *   - When the idle cap is exceeded, the stalest idle/unviewed PTY is released.
 */

export interface PtyHandle {
  pid: number;
  killed: boolean;
  kill: (signal?: string) => void;
}

export interface PtyLifecycleOpts {
  maxLivePtys: number;
  /** Called after a new PTY session is adopted — used to refresh gateway.json pids. */
  onAdopt?: (sessionId: string) => void;
  /** Called after a PTY is killed/removed — used to clean the --settings file, hook registry, gateway.json pids. */
  onCleanup?: (sessionId: string) => void;
  /** Called after adoption or state changes may have changed global idle-cap pressure. */
  onIdleStateChange?: () => void;
  /** Default true. Server-managed lifecycles disable this and enforce one global cap. */
  enforceLocalCap?: boolean;
}

export interface PtyAdoptState {
  /** Set for cold spawns that are immediately serving a turn. */
  turnRunning?: boolean;
  /** Optional initial viewer count for a terminal-born PTY. */
  viewerCount?: number;
}

interface Entry {
  handle: PtyHandle;
  turnRunning: boolean;
  runtimeActive: boolean;
  viewerCount: number;
  viewingEndedAt: number; // epoch ms; 0 while at least one viewer is attached
  lastTurnEndedAt: number; // epoch ms; 0 if no turn has completed yet
}

export interface PtyIdleCandidate {
  manager: PtyLifecycleManager;
  sessionId: string;
  idleSince: number;
}

export function enforcePtyIdleCap(managers: PtyLifecycleManager[], maxIdlePtys: number): void {
  const max = Math.max(0, maxIdlePtys);
  const candidates = managers
    .flatMap((manager) => manager.idleCandidates())
    .sort((a, b) => a.idleSince - b.idleSince);

  while (candidates.length > max) {
    const victim = candidates.shift();
    if (!victim) return;
    victim.manager.releaseSession(victim.sessionId);
  }
}

export class PtyLifecycleManager {
  private entries = new Map<string, Entry>();
  private releaseListeners: Array<(sessionId: string) => void> = [];

  constructor(private opts: PtyLifecycleOpts) {}

  adopt(sessionId: string, handle: PtyHandle, state: PtyAdoptState = {}): void {
    const turnRunning = state.turnRunning === true;
    const viewerCount = Math.max(0, state.viewerCount ?? 0);
    this.entries.set(sessionId, {
      handle,
      turnRunning,
      runtimeActive: false,
      viewerCount,
      viewingEndedAt: viewerCount > 0 ? 0 : Date.now(),
      lastTurnEndedAt: turnRunning ? 0 : Date.now(),
    });
    this.opts.onAdopt?.(sessionId);
    this.enforceLocalIdleCap();
    this.opts.onIdleStateChange?.();
  }

  getWarm(sessionId: string): PtyHandle | undefined {
    return this.entries.get(sessionId)?.handle;
  }

  isAtCapacity(): boolean {
    return this.idleWarmCount() >= this.opts.maxLivePtys;
  }

  livePids(): number[] {
    return [...this.entries.values()].map((e) => e.handle.pid);
  }

  viewerEnter(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.viewerCount += 1;
    e.viewingEndedAt = 0;
  }

  viewerLeave(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.viewerCount = Math.max(0, e.viewerCount - 1);
    if (e.viewerCount === 0) {
      e.viewingEndedAt = Date.now();
      this.enforceLocalIdleCap();
      this.opts.onIdleStateChange?.();
    }
  }

  turnStarted(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e) e.turnRunning = true;
  }

  setRuntimeActive(sessionId: string, active: boolean): void {
    const e = this.entries.get(sessionId);
    if (!e || e.runtimeActive === active) return;
    e.runtimeActive = active;
    this.enforceLocalIdleCap();
    this.opts.onIdleStateChange?.();
  }

  turnEnded(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.turnRunning = false;
    e.lastTurnEndedAt = Date.now();
    this.enforceLocalIdleCap();
    this.opts.onIdleStateChange?.();
  }

  /** Engine-side release hook: invoked for EVERY released session (manual release,
   *  LRU eviction, sweep reap, killAll), after the gateway's onCleanup. Engines use
   *  it to purge per-session bookkeeping (spawn params, output timestamps) so their
   *  maps don't grow forever in a long-running daemon. */
  onRelease(listener: (sessionId: string) => void): void {
    this.releaseListeners.push(listener);
  }

  releaseSession(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.entries.delete(sessionId);
    if (!e.handle.killed) {
      e.handle.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (!e.handle.killed) e.handle.kill("SIGKILL");
      }, 2000);
      forceKill.unref?.();
    }
    this.opts.onCleanup?.(sessionId);
    for (const l of this.releaseListeners) l(sessionId);
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.releaseSession(id);
  }

  /** Release only PTYs that are not serving foreground or native runtime work.
   *  A session is spared if its entry has `turnRunning` / `runtimeActive` set OR
   *  the caller's `isActive` predicate flags it (covers the cold-spawn window
   *  where the engine's active set is populated before `turnStarted` mirrors it). */
  releaseIdle(isActive: (sessionId: string) => boolean): void {
    for (const [id, e] of [...this.entries.entries()]) {
      if (e.turnRunning || e.runtimeActive || isActive(id)) continue;
      this.releaseSession(id);
    }
  }

  private idleWarmCount(): number {
    let count = 0;
    for (const e of this.entries.values()) {
      if (!e.turnRunning && !e.runtimeActive && e.viewerCount === 0) count++;
    }
    return count;
  }

  idleCandidates(): PtyIdleCandidate[] {
    const candidates: PtyIdleCandidate[] = [];
    for (const [sessionId, e] of this.entries.entries()) {
      if (e.turnRunning || e.runtimeActive || e.viewerCount > 0) continue;
      candidates.push({
        manager: this,
        sessionId,
        idleSince: Math.max(e.viewingEndedAt, e.lastTurnEndedAt),
      });
    }
    return candidates;
  }

  private enforceLocalIdleCap(): void {
    if (this.opts.enforceLocalCap === false) return;
    enforcePtyIdleCap([this], this.opts.maxLivePtys);
  }

  dispose(): void {
    this.killAll();
  }
}
