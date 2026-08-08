import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../shared/logger.js";

export interface PacingSnapshot {
  hasQueuedWork: boolean;
}

export type PacingStateReader = () => PacingSnapshot | Promise<PacingSnapshot>;

// Integration point for Lane 1's M4 (shared/pacing-controller.ts): that module
// hadn't landed when this was written. Once it exists, replace this reader with
// one that calls its real evaluated state (queued work AND not deliberately
// idling for weekly-pace reasons). Until then, no signal means no wake lock —
// the safe default, since asserting unconditionally is exactly the bug this
// gate exists to prevent.
export const defaultPacingStateReader: PacingStateReader = () => ({ hasQueuedWork: false });

export interface WakeLockCommand {
  command: string;
  args: string[];
}

// Idle-sleep only, lid open. caffeinate/systemd-inhibit never see the lid-close
// signal (IOPMrootDomain on macOS) — closing the lid sleeps the machine
// regardless of this assertion. Lid-closed operation needs macOS clamshell
// mode (external/dummy display), a one-time physical setup step for the user;
// see docs/tengu/14-lid-close-mode.md. Not automated here, deliberately.
export function resolveWakeLockCommand(platform: NodeJS.Platform = process.platform): WakeLockCommand | undefined {
  if (platform === "darwin") return { command: "caffeinate", args: ["-i"] };
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: ["--what=idle:sleep", "--who=tengu", "--why=pacing controller has queued work", "--mode=block", "sleep", "infinity"],
    };
  }
  return undefined;
}

export type SpawnFn = typeof spawn;

export interface WakeLockDeps {
  reader?: PacingStateReader;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
}

export class WakeLockSupervisor {
  private readonly reader: PacingStateReader;
  private readonly spawnFn: SpawnFn;
  private readonly platform: NodeJS.Platform;
  private child: ChildProcess | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: WakeLockDeps = {}) {
    this.reader = deps.reader ?? defaultPacingStateReader;
    this.spawnFn = deps.spawn ?? spawn;
    this.platform = deps.platform ?? process.platform;
  }

  get active(): boolean {
    return this.child !== undefined;
  }

  async check(): Promise<boolean> {
    const snapshot = await this.reader();
    if (snapshot.hasQueuedWork) this.assert();
    else this.release();
    return this.active;
  }

  private assert(): void {
    if (this.child) return;
    const command = resolveWakeLockCommand(this.platform);
    if (!command) {
      logger.warn(`wake-lock: no sleep-inhibitor available on platform "${this.platform}"`);
      return;
    }
    const child = this.spawnFn(command.command, command.args, { stdio: "ignore" });
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
    });
    child.on("error", (err) => {
      logger.warn(`wake-lock: failed to start ${command.command}: ${err.message}`);
      if (this.child === child) this.child = undefined;
    });
    this.child = child;
    logger.info(`wake-lock: asserted via ${command.command} — pacing controller reports queued work`);
  }

  private release(): void {
    if (!this.child) return;
    logger.info("wake-lock: released — pacing controller reports no queued work");
    this.child.kill();
    this.child = undefined;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch((err) => {
        logger.warn(`wake-lock: state check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
    this.timer.unref?.();
    void this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.release();
  }
}
