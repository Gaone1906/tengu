import cron from "node-cron";
import type {
  CronJob,
  JinnConfig,
  Connector,
} from "../shared/types.js";
import { runCronJob, type WorkflowCronFire } from "./runner.js";
import { logger } from "../shared/logger.js";
import type { SessionManager } from "../sessions/manager.js";
import { loadJobs, saveJobs } from "./jobs.js";

let tasks: cron.ScheduledTask[] = [];
let currentSessionManager: SessionManager;
let currentConfig: JinnConfig;
let currentConnectors: Map<string, Connector>;
let currentWorkflowFire: WorkflowCronFire | undefined;

/**
 * Wire (or clear) the managed-workflow fire handler (GRS-014d). The gateway sets it
 * once at boot AFTER the ApiContext exists (the handler closes over it); fire
 * closures read the CURRENT value at fire time, so wiring after startScheduler is
 * safe — a managed fire in the sub-second unwired window no-ops honestly in the
 * runner. Left unset on a gateway with no workflow surface → managed jobs are inert.
 */
export function setWorkflowCronFire(fire: WorkflowCronFire | undefined): void {
  currentWorkflowFire = fire;
}

export function startScheduler(
  jobs: CronJob[],
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
): void {
  currentSessionManager = sessionManager;
  currentConfig = config;
  currentConnectors = connectors;
  scheduleJobs(jobs);
}

export function reloadScheduler(jobs: CronJob[]): void {
  stopScheduler();
  scheduleJobs(jobs);
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}

function scheduleJobs(jobs: CronJob[]): void {
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!cron.validate(job.schedule)) {
      logger.warn(
        `Invalid cron schedule for job "${job.name}": ${job.schedule}`,
      );
      continue;
    }
    const task = cron.schedule(
      job.schedule,
      () => {
        // Capture the fire identity once, at fire time, so it's owned by this fire
        // (not recomputed inside runCronJob). A retry reusing this fireIso is
        // idempotent across session/work-item/link (GRS-003b-1).
        const fireIso = new Date().toISOString();
        runCronJob(job, currentSessionManager, currentConfig, currentConnectors, { fireIso, workflowFire: currentWorkflowFire }).catch((err) => {
          logger.error(
            `Cron job "${job.name}" crashed: ${err instanceof Error ? err.message : err}`,
          );
        });
      },
      { timezone: job.timezone },
    );
    tasks.push(task);
    logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
  }
}

export async function triggerCronJob(idOrName: string): Promise<CronJob | undefined> {
  const job = findJob(idOrName);
  if (!job) return undefined;
  // Manual `/cron run <job>` is a human "run it now" — like the gateway's HTTP
  // run-now (api.ts), it passes NO `fireIso`. Each manual trigger is a fresh fire
  // (runner defaults to a new per-call ISO), so it is never subject to the
  // single-shot execution guard (GRS-003b-2a) and always runs. Only the scheduled
  // TICK carries a deterministic per-fire identity — the locus a future retrying
  // dispatcher (GRS-003b-2c) leans on for at-most-once execution. A managed workflow
  // job triggered manually starts a fresh workflow run the same way (fresh fireIso).
  await runCronJob(job, currentSessionManager, currentConfig, currentConnectors, { workflowFire: currentWorkflowFire });
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
