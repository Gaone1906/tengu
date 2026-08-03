import crypto from "node:crypto";
import { canonicalCronJobId, loadJobs, saveJobs } from "../cron/jobs.js";
import { validateCronSchedule } from "../cron/validation.js";
import type { CronJob, Experiment, ExperimentStoreResult } from "../shared/types.js";
import {
  concludeExperiment,
  createExperiment,
  getExperiment,
  type ConcludeExperimentInput,
  type CreateExperimentInput,
} from "./store.js";

export interface ExperimentCheckInInput {
  schedule: string;
  employee?: string;
  timezone?: string;
}

type Failure = Extract<ExperimentStoreResult<never>, { ok: false }>;

function failure(reason: Failure["reason"], detail: string): Failure {
  return { ok: false, reason, detail };
}

function generatedExperimentId(): string {
  return `exp_${crypto.randomBytes(6).toString("hex")}`;
}

function checkInPrompt(experiment: Pick<Experiment, "id" | "name" | "metrics">): string {
  const instructions = experiment.metrics
    .map((metric) => `- ${metric.name}${metric.unit ? ` (${metric.unit})` : ""}: ${metric.howToMeasure}`)
    .join("\n");
  return [
    `Check in on experiment "${experiment.name}" (${experiment.id}).`,
    "Measure every declared metric using these instructions:",
    instructions,
    `Append each result with record_reading using id "${experiment.id}".`,
  ].join("\n\n");
}

function validateCheckIn(input: ExperimentCheckInInput): Failure | null {
  const errors = validateCronSchedule({ schedule: input.schedule, timezone: input.timezone });
  if (errors.length > 0) return failure("invalid", errors.map((error) => `${error.field}: ${error.message}`).join("; "));
  if (input.employee !== undefined && (typeof input.employee !== "string" || !input.employee.trim())) {
    return failure("invalid", "employee must be a non-empty string");
  }
  return null;
}

export function registerExperimentCheckIn(
  experiment: Pick<Experiment, "id" | "name" | "metrics">,
  input: ExperimentCheckInInput,
  jobId = `experiment-check-in-${experiment.id}`,
): ExperimentStoreResult<CronJob> {
  const invalid = validateCheckIn(input);
  if (invalid) return invalid;
  const jobs = loadJobs();
  const canonicalId = canonicalCronJobId(jobId);
  if (jobs.some((job) => canonicalCronJobId(job.id) === canonicalId)) {
    return failure("conflict", `cron job "${jobId}" already exists`);
  }
  const job: CronJob = {
    id: jobId,
    name: `Experiment check-in: ${experiment.name}`,
    enabled: true,
    schedule: input.schedule.trim(),
    ...(input.timezone ? { timezone: input.timezone.trim() } : {}),
    ...(input.employee ? { employee: input.employee.trim() } : {}),
    prompt: checkInPrompt(experiment),
  };
  saveJobs([...jobs, job]);
  return { ok: true, value: job };
}

export function disableExperimentCheckIn(jobId: string): void {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => canonicalCronJobId(job.id) === canonicalCronJobId(jobId));
  if (index < 0 || !jobs[index].enabled) return;
  const next = [...jobs];
  next[index] = { ...next[index], enabled: false };
  saveJobs(next);
}

export function removeExperimentCheckIn(jobId: string): void {
  const jobs = loadJobs();
  const next = jobs.filter((job) => canonicalCronJobId(job.id) !== canonicalCronJobId(jobId));
  if (next.length !== jobs.length) saveJobs(next);
}

export function createExperimentWithCheckIn(
  input: CreateExperimentInput,
  checkIn?: ExperimentCheckInInput,
): ExperimentStoreResult<Experiment> {
  if (!checkIn) return createExperiment(input);
  const invalid = validateCheckIn(checkIn);
  if (invalid) return invalid;

  const id = generatedExperimentId();
  const jobId = `experiment-check-in-${id}`;
  const registered = registerExperimentCheckIn({ id, name: input.name, metrics: input.metrics }, checkIn, jobId);
  if (!registered.ok) return registered;
  try {
    const created = createExperiment(input, { id, checkInCronJobId: jobId });
    if (!created.ok) removeExperimentCheckIn(jobId);
    return created;
  } catch (error) {
    removeExperimentCheckIn(jobId);
    throw error;
  }
}

export function concludeExperimentAndDisableCheckIn(
  id: string,
  input: ConcludeExperimentInput,
): ExperimentStoreResult<Experiment> {
  const existing = getExperiment(id);
  if (!existing.ok) return existing;
  if (existing.value.status !== "running") return failure("conflict", "experiment is already concluded");
  if (existing.value.checkInCronJobId) disableExperimentCheckIn(existing.value.checkInCronJobId);
  return concludeExperiment(id, input);
}
