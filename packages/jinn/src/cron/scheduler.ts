import cron from "node-cron";
import type {
  CronJob,
  JinnConfig,
  Connector,
} from "../shared/types.js";
import { runCronJob } from "./runner.js";
import { logger } from "../shared/logger.js";
import type { SessionManager } from "../sessions/manager.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import { loadJobs, saveJobs, upsertJob, appendRunLog } from "./jobs.js";
import { validateCronSchedule } from "./validation.js";

/** Resumes a governor-halted session in place (--resume on the same engine
 *  session) rather than minting a new one — wired by gateway/server.ts to
 *  gateway/api.ts's resumeGovernorHaltedSession. Absent in contexts with no
 *  live ApiContext (tests, CLI-only paths); a "runAt" job with no callback
 *  configured logs and no-ops rather than throwing. */
export type ResumeSessionFn = (sessionKey: string, jobId: string) => Promise<void> | void;

let tasks: cron.ScheduledTask[] = [];
let currentSessionManager: SessionManager;
let currentConfig: JinnConfig;
let currentConnectors: Map<string, Connector>;
let currentEmit: GatewayEmit | undefined;
let currentResumeSession: ResumeSessionFn | undefined;

export function startScheduler(
  jobs: CronJob[],
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
  emit?: GatewayEmit,
  resumeSession?: ResumeSessionFn,
): void {
  currentSessionManager = sessionManager;
  currentConfig = config;
  currentConnectors = connectors;
  currentEmit = emit;
  currentResumeSession = resumeSession;
  const started: cron.ScheduledTask[] = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    try {
      const task = createTask(job);
      task.start();
      started.push(task);
      logger.info(`Scheduled cron job "${job.name}" (${job.kind === "runAt" ? job.runAt : job.schedule})`);
    } catch (err) {
      logger.warn(`Skipping invalid cron job "${job.name}" at boot: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const task of tasks) task.stop();
  tasks = started;
}

export function reloadScheduler(jobs: CronJob[]): boolean {
  const replacements: cron.ScheduledTask[] = [];
  try {
    for (const job of jobs) {
      if (!job.enabled) continue;
      replacements.push(createTask(job));
    }
    for (const task of replacements) task.start();
  } catch (err) {
    for (const task of replacements) task.stop();
    logger.warn(`Cron reload rejected; keeping existing scheduler: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  for (const task of tasks) task.stop();
  tasks = replacements;
  for (const job of jobs) {
    if (job.enabled) logger.info(`Scheduled cron job "${job.name}" (${job.kind === "runAt" ? job.runAt : job.schedule})`);
  }
  return true;
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}

function createTask(job: CronJob): cron.ScheduledTask {
  if (job.kind === "runAt") return createRunAtTask(job);

  const validation = validateCronSchedule({ schedule: job.schedule, ...(job.timezone !== undefined ? { timezone: job.timezone } : {}) });
  if (validation.length > 0) {
    throw new Error(validation.map((entry) => entry.message).join('; '));
  }
  return cron.schedule(
    job.schedule,
    () => {
      // Capture the fire identity once, at fire time, so it's owned by this fire
      // (not recomputed inside runCronJob). A retry reusing this fireIso is
      // idempotent across session/work-item/link (GRS-003b-1).
      const fireIso = new Date().toISOString();
      runCronJob(job, currentSessionManager, currentConfig, currentConnectors, { fireIso, emit: currentEmit }).catch((err) => {
        logger.error(`Cron job "${job.name}" crashed: ${err instanceof Error ? err.message : err}`);
      });
    },
    { timezone: job.timezone, scheduled: false },
  );
}

/**
 * A "runAt" job fires exactly once, at an absolute timestamp — node-cron has
 * no such primitive, so this bypasses it entirely and uses a plain timer.
 * Durable across a gateway restart because the delay is recomputed from the
 * persisted `runAt` every time `start()` runs (at boot, via startScheduler):
 * a fire missed during downtime becomes a near-zero delay (catches up) rather
 * than being lost. `unref()` so a pending resume never keeps the process
 * alive (matters for tests and for CLI-only short-lived processes).
 */
function createRunAtTask(job: CronJob): cron.ScheduledTask {
  const validation = validateCronSchedule({
    schedule: job.schedule,
    kind: "runAt",
    runAt: job.runAt,
    ...(job.timezone !== undefined ? { timezone: job.timezone } : {}),
  });
  if (validation.length > 0) {
    throw new Error(validation.map((entry) => entry.message).join('; '));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const task = {
    start() {
      // setTimeout's delay is a 32-bit signed int (~24.8 days); every "runAt"
      // job in this system fires within hours (governor resume = 5h window +
      // 60s), so no chained-timer handling is needed for the overflow case.
      const delayMs = Math.max(0, new Date(job.runAt!).getTime() - Date.now());
      timer = setTimeout(() => fireRunAt(job), delayMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
  return task as unknown as cron.ScheduledTask;
}

function fireRunAt(job: CronJob): void {
  const fireIso = new Date().toISOString();
  const settle = (status: "success" | "error", error: string | null) => {
    appendRunLog(job.id, {
      timestamp: fireIso,
      sessionKey: job.resumeSessionKey ?? null,
      status,
      durationMs: 0,
      error,
      resultPreview: null,
    });
    disableOneShotJob(job.id);
  };

  if (job.resumeSessionKey) {
    if (!currentResumeSession) {
      logger.warn(`Cron job "${job.name}" (${job.id}) wants to resume session "${job.resumeSessionKey}" but no resume handler is wired — skipping.`);
      settle("error", "no resumeSession handler configured");
      return;
    }
    Promise.resolve(currentResumeSession(job.resumeSessionKey, job.id))
      .then(() => settle("success", null))
      .catch((err) => {
        logger.error(`Resume cron job "${job.name}" (${job.id}) failed: ${err instanceof Error ? err.message : err}`);
        settle("error", err instanceof Error ? err.message : String(err));
      });
    return;
  }

  runCronJob(job, currentSessionManager, currentConfig, currentConnectors, { fireIso, emit: currentEmit })
    .catch((err) => {
      logger.error(`Cron job "${job.name}" crashed: ${err instanceof Error ? err.message : err}`);
    })
    .finally(() => disableOneShotJob(job.id));
}

/** A "runAt" job is single-fire by definition — disable it on disk once it has
 *  fired so a later reload/boot never reschedules it. */
function disableOneShotJob(jobId: string): void {
  const jobs = loadJobs();
  const job = jobs.find((entry) => entry.id === jobId);
  if (job && job.kind === "runAt" && job.enabled) {
    upsertJob({ ...job, enabled: false });
  }
}

export async function triggerCronJob(idOrName: string): Promise<CronJob | undefined> {
  const job = findJob(idOrName);
  if (!job) return undefined;
  if (job.kind === "runAt" && job.resumeSessionKey) {
    if (currentResumeSession) await currentResumeSession(job.resumeSessionKey, job.id);
    return job;
  }
  // Manual `/cron run <job>` is a human "run it now" — like the gateway's HTTP
  // run-now (api.ts), it passes NO `fireIso`. Each manual trigger is a fresh fire
  // (runner defaults to a new per-call ISO), so it is never subject to the
  // single-shot execution guard (GRS-003b-2a) and always runs. Only the scheduled
  // TICK carries a deterministic per-fire identity — the locus a future retrying
  // dispatcher (GRS-003b-2c) leans on for at-most-once execution.
  await runCronJob(job, currentSessionManager, currentConfig, currentConnectors, { emit: currentEmit });
  return job;
}

export function setCronJobEnabled(idOrName: string, enabled: boolean): CronJob | undefined {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => matchesJob(job, idOrName));
  if (index === -1) return undefined;
  jobs[index] = { ...jobs[index], enabled };
  saveJobs(jobs);
  reloadScheduler(jobs);
  return jobs[index];
}

function findJob(idOrName: string): CronJob | undefined {
  return loadJobs().find((job) => matchesJob(job, idOrName));
}

function matchesJob(job: CronJob, idOrName: string): boolean {
  const needle = idOrName.trim().toLowerCase();
  return job.id.toLowerCase() === needle || job.name.toLowerCase() === needle;
}
