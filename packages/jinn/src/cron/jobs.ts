import fs from "node:fs";
import path from "node:path";
import type { CronJob } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export function loadJobs(): CronJob[] {
  let raw: string;
  try {
    raw = fs.readFileSync(CRON_JOBS, "utf-8");
  } catch (err) {
    // Missing file is normal (no cron jobs configured yet); anything else is not.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(
        `Failed to read cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return [];
  }
  try {
    return JSON.parse(raw) as CronJob[];
  } catch (err) {
    // Corrupt JSON: preserve the broken file for the operator, then run with no jobs.
    const backupPath = `${CRON_JOBS}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(CRON_JOBS, backupPath);
    } catch {
      // best effort — the original file is still on disk
    }
    logger.error(
      `Failed to parse cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}. ` +
      `Corrupt copy saved to ${backupPath}; running with zero cron jobs.`,
    );
    return [];
  }
}

export function saveJobs(jobs: CronJob[]): void {
  const dir = path.dirname(CRON_JOBS);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: tmp file + rename so a crash mid-write can't corrupt jobs.json.
  const tmpPath = `${CRON_JOBS}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(jobs, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, CRON_JOBS);
}

/**
 * Canonical cron-job identity for collision checks. Run-log files are
 * `<id>.jsonl` under CRON_RUNS and the default
 * macOS volume is case-insensitive, so ids differing only by case (or by
 * leading/trailing whitespace) share ONE run-history file — a filesystem
 * constraint the code cannot otherwise show. Identity therefore compares
 * trimmed + lowercased. Storage is untouched: jobs keep their authored id
 * everywhere; only collision comparisons canonicalize. Unicode is
 * NFC-normalized first: macOS additionally treats NFC/NFD
 * variants of one name as the same file, so composed vs decomposed ids would
 * also share a run history.
 */
export function canonicalCronJobId(id: string): string {
  return id.trim().normalize("NFC").toLowerCase();
}

export function appendRunLog(jobId: string, entry: object): void {
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/** Terminal cron run-log outcomes — the states `appendRunLog` records once a fire
 *  has actually completed (successfully or with an error). `hasRunLogEntry` matches
 *  ONLY these, so a non-terminal marker (e.g. a future `status: "started"` row, or a
 *  schema-corrupt statusless-but-parseable row) can never make the guard skip a fire
 *  that only started or crashed mid-run. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["success", "error"]);

/**
 * True if the job's run-log already contains a COMPLETED (terminal) entry whose
 * `sessionKey` matches. The per-job jsonl is the durable single-shot ledger for cron
 * execution idempotency (GRS-003b-2a): a deterministic re-fire (same
 * `cron:<jobId>:<fireIso>` key) that already ran to an outcome must not run again.
 *
 * Matches only rows whose `status` is terminal (`success`/`error`) — a bare or
 * `started` marker for the same key does NOT count as executed, so an in-flight or
 * crashed-mid-run fire stays retryable. (A pre-execution `started` marker to close the
 * concurrent-in-flight window is the deferred GRS-003b-2c dispatcher work.)
 *
 * Never throws — a missing log file (the normal "no runs yet" case) returns false
 * silently, and any other read error also returns false (fail-open: for a cron job,
 * running twice is less harmful than a read hiccup permanently skipping it). Corrupt
 * jsonl lines are skipped individually so one bad line can't mask a real match on
 * another line. Cron run-logs are low-volume, so a full read per fire is fine.
 */
export function hasRunLogEntry(jobId: string, sessionKey: string): boolean {
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        `Failed to read cron run-log ${logPath}: ${err instanceof Error ? err.message : err}. ` +
        `Treating fire as not-yet-run (fail-open).`,
      );
    }
    return false;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { sessionKey?: string; status?: string };
      if (entry.sessionKey === sessionKey && typeof entry.status === "string" && TERMINAL_RUN_STATUSES.has(entry.status)) {
        return true;
      }
    } catch {
      // Skip a corrupt line; keep scanning — a real match may be on a later line.
    }
  }
  return false;
}
