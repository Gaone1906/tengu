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
import { loadJobs, saveJobs } from "./jobs.js";
import { validateCronSchedule } from "./validation.js";

let tasks: cron.ScheduledTask[] = [];
let currentSessionManager: SessionManager;
let currentConfig: JinnConfig;
let currentConnectors: Map<string, Connector>;
let currentEmit: GatewayEmit | undefined;
export function startScheduler(
  jobs: CronJob[],
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
  emit?: GatewayEmit,
): void {
  currentSessionManager = sessionManager;
  currentConfig = config;
  currentConnectors = connectors;
  currentEmit = emit;
  const started: cron.ScheduledTask[] = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    try {
      const task = createTask(job);
      task.start();
      started.push(task);
      logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
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
    if (job.enabled) logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
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

export async function triggerCronJob(idOrName: string): Promise<CronJob | undefined> {
  const job = findJob(idOrName);
  if (!job) return undefined;
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
