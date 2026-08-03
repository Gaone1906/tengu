import crypto from "node:crypto";
import { initDb } from "../shared/db.js";
import type {
  Experiment,
  ExperimentMetric,
  ExperimentReading,
  ExperimentStoreResult,
  ExperimentVerdict,
} from "../shared/types.js";

export type { Experiment, ExperimentMetric, ExperimentReading, ExperimentStoreResult, ExperimentVerdict } from "../shared/types.js";

export interface CreateExperimentInput {
  name: string;
  hypothesis: string;
  baseline: Record<string, number>;
  metrics: ExperimentMetric[];
  horizonDays: number;
}

export interface UpdateExperimentInput {
  name?: string;
  hypothesis?: string;
  metrics?: ExperimentMetric[];
  horizonDays?: number;
}

export interface RecordReadingInput {
  at: string;
  metric: string;
  value: number;
  note?: string;
}

export interface ConcludeExperimentInput {
  outcome: ExperimentVerdict["outcome"];
  note: string;
}

interface CreateExperimentInternal {
  id?: string;
  checkInCronJobId?: string;
}

type Failure = Extract<ExperimentStoreResult<never>, { ok: false }>;

const NAME_MAX = 240;
const HYPOTHESIS_MAX = 8_000;
const METRIC_NAME_MAX = 120;
const UNIT_MAX = 64;
const MEASUREMENT_MAX = 4_000;
const NOTE_MAX = 8_000;

function failure(reason: Failure["reason"], detail: string): Failure {
  return { ok: false, reason, detail };
}

function isFailure<T>(value: T | Failure): value is Failure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function requiredText(value: unknown, field: string, max: number): string | Failure {
  if (typeof value !== "string" || !value.trim()) return failure("invalid", `${field} is required and must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max) return failure("invalid", `${field} is too long (${normalized.length} chars, max ${max})`);
  return normalized;
}

function normalizeMetrics(value: unknown): ExperimentMetric[] | Failure {
  if (!Array.isArray(value) || value.length === 0) return failure("invalid", "metrics must contain at least one metric");
  const metrics: ExperimentMetric[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure("invalid", "each metric must be an object");
    const record = raw as Record<string, unknown>;
    const name = requiredText(record.name, "metric name", METRIC_NAME_MAX);
    if (typeof name !== "string") return name;
    if (names.has(name)) return failure("invalid", `metric names must be unique; "${name}" appears more than once`);
    const howToMeasure = requiredText(record.howToMeasure, `howToMeasure for ${name}`, MEASUREMENT_MAX);
    if (typeof howToMeasure !== "string") return howToMeasure;
    let unit: string | undefined;
    if (record.unit !== undefined) {
      const normalizedUnit = requiredText(record.unit, `unit for ${name}`, UNIT_MAX);
      if (typeof normalizedUnit !== "string") return normalizedUnit;
      unit = normalizedUnit;
    }
    names.add(name);
    metrics.push({ name, ...(unit ? { unit } : {}), howToMeasure });
  }
  return metrics;
}

function normalizeHorizon(value: unknown): number | Failure {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 36_500) {
    return failure("invalid", "horizonDays must be a positive integer no greater than 36500");
  }
  return value;
}

function normalizeBaseline(value: unknown, metrics: ExperimentMetric[]): Record<string, number> | Failure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("invalid", "baseline must be an object of finite metric values");
  const baseline = value as Record<string, unknown>;
  const names = new Set(metrics.map((metric) => metric.name));
  for (const name of names) {
    if (typeof baseline[name] !== "number" || !Number.isFinite(baseline[name])) {
      return failure("invalid", `baseline must include a finite number for metric "${name}"`);
    }
  }
  for (const [name, metricValue] of Object.entries(baseline)) {
    if (!names.has(name)) return failure("invalid", `baseline metric "${name}" is not declared in metrics`);
    if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) {
      return failure("invalid", `baseline value for "${name}" must be finite`);
    }
  }
  return Object.fromEntries(Object.entries(baseline).map(([name, metricValue]) => [name, metricValue as number]));
}

function experimentId(): string {
  return `exp_${crypto.randomBytes(6).toString("hex")}`;
}

function readingId(): string {
  return `rd_${crypto.randomBytes(6).toString("hex")}`;
}

function readMetrics(id: string): ExperimentMetric[] {
  const rows = initDb().prepare(
    `SELECT name, unit, how_to_measure
       FROM experiment_metrics
      WHERE experiment_id = ?
      ORDER BY ordinal, name`,
  ).all(id) as Array<{ name: string; unit: string | null; how_to_measure: string }>;
  return rows.map((row) => ({
    name: row.name,
    ...(row.unit ? { unit: row.unit } : {}),
    howToMeasure: row.how_to_measure,
  }));
}

function readReadings(id: string): ExperimentReading[] {
  const rows = initDb().prepare(
    `SELECT id, experiment_id, at, metric, value, note
       FROM experiment_readings
      WHERE experiment_id = ?
      ORDER BY at, id`,
  ).all(id) as Array<{ id: string; experiment_id: string; at: string; metric: string; value: number; note: string | null }>;
  return rows.map((row) => ({
    id: row.id,
    experimentId: row.experiment_id,
    at: row.at,
    metric: row.metric,
    value: row.value,
    ...(row.note ? { note: row.note } : {}),
  }));
}

function rowToExperiment(row: Record<string, unknown>): Experiment {
  const outcome = row.verdict_outcome as ExperimentVerdict["outcome"] | null;
  const concludedAt = row.concluded_at as string | null;
  const verdictNote = row.verdict_note as string | null;
  return {
    id: row.id as string,
    name: row.name as string,
    hypothesis: row.hypothesis as string,
    status: row.status as Experiment["status"],
    startedAt: row.started_at as string,
    horizonDays: row.horizon_days as number,
    baseline: JSON.parse(row.baseline_json as string) as Record<string, number>,
    metrics: readMetrics(row.id as string),
    readings: readReadings(row.id as string),
    ...(outcome && concludedAt && verdictNote !== null
      ? { verdict: { outcome, note: verdictNote, concludedAt } }
      : {}),
    ...(typeof row.check_in_cron_job_id === "string" && row.check_in_cron_job_id
      ? { checkInCronJobId: row.check_in_cron_job_id }
      : {}),
  };
}

export function getExperiment(id: string): ExperimentStoreResult<Experiment> {
  const row = initDb().prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? { ok: true, value: rowToExperiment(row) } : failure("not-found", `experiment "${id}" was not found`);
}

export function listExperiments(status?: Experiment["status"]): Experiment[] {
  const rows = (status
    ? initDb().prepare("SELECT * FROM experiments WHERE status = ? ORDER BY started_at DESC, id").all(status)
    : initDb().prepare("SELECT * FROM experiments ORDER BY started_at DESC, id").all()) as Record<string, unknown>[];
  return rows.map(rowToExperiment);
}

export function createExperiment(
  input: CreateExperimentInput,
  internal: CreateExperimentInternal = {},
): ExperimentStoreResult<Experiment> {
  const name = requiredText(input.name, "name", NAME_MAX);
  if (typeof name !== "string") return name;
  const hypothesis = requiredText(input.hypothesis, "hypothesis", HYPOTHESIS_MAX);
  if (typeof hypothesis !== "string") return hypothesis;
  const metrics = normalizeMetrics(input.metrics);
  if (!Array.isArray(metrics)) return metrics;
  const horizonDays = normalizeHorizon(input.horizonDays);
  if (typeof horizonDays !== "number") return horizonDays;
  const baseline = normalizeBaseline(input.baseline, metrics);
  if (isFailure(baseline)) return baseline;

  const id = internal.id ?? experimentId();
  const startedAt = new Date().toISOString();
  const db = initDb();
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO experiments
        (id, name, hypothesis, status, started_at, horizon_days, baseline_json, check_in_cron_job_id)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(id, name, hypothesis, startedAt, horizonDays, JSON.stringify(baseline), internal.checkInCronJobId ?? null);
    const insertMetric = db.prepare(
      `INSERT INTO experiment_metrics (experiment_id, ordinal, name, unit, how_to_measure)
       VALUES (?, ?, ?, ?, ?)`,
    );
    metrics.forEach((metric, ordinal) => insertMetric.run(id, ordinal, metric.name, metric.unit ?? null, metric.howToMeasure));
  });
  insert();
  return getExperiment(id);
}

export function recordReading(id: string, input: RecordReadingInput): ExperimentStoreResult<ExperimentReading> {
  const existing = getExperiment(id);
  if (!existing.ok) return existing;
  if (existing.value.status !== "running") return failure("conflict", "readings cannot be added after an experiment is concluded");
  const metric = requiredText(input.metric, "metric", METRIC_NAME_MAX);
  if (typeof metric !== "string") return metric;
  if (!existing.value.metrics.some((candidate) => candidate.name === metric)) {
    return failure("invalid", `metric "${metric}" is not declared on this experiment`);
  }
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) return failure("invalid", "value must be a finite number");
  if (typeof input.at !== "string" || !input.at.trim() || Number.isNaN(Date.parse(input.at))) {
    return failure("invalid", "at must be an ISO-8601 timestamp");
  }
  let note: string | undefined;
  if (input.note !== undefined) {
    if (typeof input.note !== "string" || input.note.length > NOTE_MAX) return failure("invalid", `note must be a string no longer than ${NOTE_MAX} chars`);
    note = input.note.trim() || undefined;
  }
  const reading: ExperimentReading = {
    id: readingId(),
    experimentId: id,
    at: new Date(input.at).toISOString(),
    metric,
    value: input.value,
    ...(note ? { note } : {}),
  };
  initDb().prepare(
    `INSERT INTO experiment_readings (id, experiment_id, at, metric, value, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(reading.id, id, reading.at, reading.metric, reading.value, reading.note ?? null);
  return { ok: true, value: reading };
}

export function updateExperiment(id: string, input: UpdateExperimentInput): ExperimentStoreResult<Experiment> {
  const existing = getExperiment(id);
  if (!existing.ok) return existing;
  if (existing.value.status !== "running") return failure("conflict", "concluded experiments cannot be edited");
  if (input.name === undefined && input.hypothesis === undefined && input.horizonDays === undefined && input.metrics === undefined) {
    return failure("invalid", "at least one editable field is required");
  }
  const name = input.name === undefined ? existing.value.name : requiredText(input.name, "name", NAME_MAX);
  if (typeof name !== "string") return name;
  const hypothesis = input.hypothesis === undefined
    ? existing.value.hypothesis
    : requiredText(input.hypothesis, "hypothesis", HYPOTHESIS_MAX);
  if (typeof hypothesis !== "string") return hypothesis;
  const horizonDays = input.horizonDays === undefined ? existing.value.horizonDays : normalizeHorizon(input.horizonDays);
  if (typeof horizonDays !== "number") return horizonDays;
  const metrics = input.metrics === undefined ? existing.value.metrics : normalizeMetrics(input.metrics);
  if (!Array.isArray(metrics)) return metrics;

  if (input.metrics !== undefined) {
    const nextNames = new Set(metrics.map((metric) => metric.name));
    const removed = existing.value.metrics.filter((metric) => !nextNames.has(metric.name)).map((metric) => metric.name);
    if (removed.length > 0) {
      const placeholders = removed.map(() => "?").join(", ");
      const count = initDb().prepare(
        `SELECT COUNT(*) FROM experiment_readings WHERE experiment_id = ? AND metric IN (${placeholders})`,
      ).pluck().get(id, ...removed) as number;
      if (count > 0) return failure("conflict", "metrics with recorded readings cannot be removed");
    }
  }

  const db = initDb();
  db.transaction(() => {
    db.prepare("UPDATE experiments SET name = ?, hypothesis = ?, horizon_days = ? WHERE id = ?")
      .run(name, hypothesis, horizonDays, id);
    if (input.metrics !== undefined) {
      const nextNames = new Set(metrics.map((metric) => metric.name));
      for (const metric of existing.value.metrics) {
        if (!nextNames.has(metric.name)) {
          db.prepare("DELETE FROM experiment_metrics WHERE experiment_id = ? AND name = ?").run(id, metric.name);
        }
      }
      const upsert = db.prepare(
        `INSERT INTO experiment_metrics (experiment_id, ordinal, name, unit, how_to_measure)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(experiment_id, name) DO UPDATE SET
           ordinal = excluded.ordinal,
           unit = excluded.unit,
           how_to_measure = excluded.how_to_measure`,
      );
      metrics.forEach((metric, ordinal) => upsert.run(id, ordinal, metric.name, metric.unit ?? null, metric.howToMeasure));
    }
  })();
  return getExperiment(id);
}

export function concludeExperiment(id: string, input: ConcludeExperimentInput): ExperimentStoreResult<Experiment> {
  const existing = getExperiment(id);
  if (!existing.ok) return existing;
  if (existing.value.status !== "running") return failure("conflict", "experiment is already concluded");
  if (input.outcome !== "win" && input.outcome !== "loss" && input.outcome !== "inconclusive") {
    return failure("invalid", "outcome must be win, loss, or inconclusive");
  }
  if (typeof input.note !== "string" || input.note.length > NOTE_MAX) {
    return failure("invalid", `note must be a string no longer than ${NOTE_MAX} chars`);
  }
  const concludedAt = new Date().toISOString();
  initDb().prepare(
    `UPDATE experiments
        SET status = 'concluded', verdict_outcome = ?, verdict_note = ?, concluded_at = ?
      WHERE id = ?`,
  ).run(input.outcome, input.note.trim(), concludedAt, id);
  return getExperiment(id);
}
