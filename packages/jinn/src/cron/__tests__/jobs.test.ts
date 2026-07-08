import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob } from "../../shared/types.js";

// Stub logger so tests don't touch the real log files
vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// CRON_JOBS is resolved at module load from process.env.JINN_HOME, so we point
// it at a temp dir and re-import the module graph per test (same pattern as
// the context.ts tests).
let tmpHome: string;
const prevHome = process.env.JINN_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-cron-jobs-"));
  process.env.JINN_HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = prevHome;
  vi.resetModules();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function importJobs() {
  const jobs = await import("../jobs.js");
  const { logger } = await import("../../shared/logger.js");
  return { ...jobs, logger };
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "do something",
    ...overrides,
  };
}

describe("loadJobs", () => {
  it("returns [] silently when jobs.json is missing", async () => {
    const { loadJobs, logger } = await importJobs();
    expect(loadJobs()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs an error and backs up the corrupt file on parse failure", async () => {
    const cronDir = path.join(tmpHome, "cron");
    fs.mkdirSync(cronDir, { recursive: true });
    const jobsPath = path.join(cronDir, "jobs.json");
    fs.writeFileSync(jobsPath, "{ not valid json", "utf-8");

    const { loadJobs, logger } = await importJobs();
    expect(loadJobs()).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.error).mock.calls[0][0])).toContain("Failed to parse");

    // Corrupt copy is preserved next to the original
    const backups = fs.readdirSync(cronDir).filter((f) => f.startsWith("jobs.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(cronDir, backups[0]), "utf-8")).toBe("{ not valid json");
    // Original file is left in place
    expect(fs.existsSync(jobsPath)).toBe(true);
  });
});

describe("saveJobs", () => {
  it("round-trips jobs through loadJobs and leaves no tmp file behind", async () => {
    const { loadJobs, saveJobs } = await importJobs();
    const jobs = [makeJob(), makeJob({ id: "other-job", name: "Other Job", enabled: false })];

    saveJobs(jobs);
    expect(loadJobs()).toEqual(jobs);

    const cronDir = path.join(tmpHome, "cron");
    const leftovers = fs.readdirSync(cronDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("hasRunLogEntry — durable single-shot ledger (GRS-003b-2a)", () => {
  it("returns false (silently) when the job has no run-log file yet", async () => {
    const { hasRunLogEntry, logger } = await importJobs();
    expect(hasRunLogEntry("never-run-job", "cron:never-run-job:x")).toBe(false);
    // Missing file is the normal "no runs yet" case — not warned.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("finds a sessionKey after appendRunLog, and isolates by key and by job", async () => {
    const { appendRunLog, hasRunLogEntry } = await importJobs();
    const jobId = "idem-job";
    const key = "cron:idem-job:2026-07-01T06:00:00.000Z";

    // Before the fire is recorded, the guard sees nothing.
    expect(hasRunLogEntry(jobId, key)).toBe(false);

    appendRunLog(jobId, { timestamp: "2026-07-01T06:00:00.000Z", sessionKey: key, status: "success" });

    // The exact fire is now on the durable ledger; a re-fire with the same key matches.
    expect(hasRunLogEntry(jobId, key)).toBe(true);
    // A different fire (different fireIso) of the same job does NOT match.
    expect(hasRunLogEntry(jobId, "cron:idem-job:2026-07-01T08:00:00.000Z")).toBe(false);
    // The same key on a different job is isolated (per-job jsonl).
    expect(hasRunLogEntry("other-job", key)).toBe(false);
  });

  it("matches across multiple appended entries (whole-log scan)", async () => {
    const { appendRunLog, hasRunLogEntry } = await importJobs();
    const jobId = "multi-job";
    appendRunLog(jobId, { sessionKey: "cron:multi-job:a", status: "error" });
    appendRunLog(jobId, { sessionKey: "cron:multi-job:b", status: "success" });
    appendRunLog(jobId, { sessionKey: "cron:multi-job:c", status: "success" });
    expect(hasRunLogEntry(jobId, "cron:multi-job:a")).toBe(true);
    expect(hasRunLogEntry(jobId, "cron:multi-job:c")).toBe(true);
    expect(hasRunLogEntry(jobId, "cron:multi-job:z")).toBe(false);
  });

  it("matches ONLY terminal outcomes — a statusless/started row for the same key is ignored", async () => {
    const { hasRunLogEntry } = await importJobs();
    const jobId = "inflight-job";
    const key = "cron:inflight-job:2026-07-01T06:00:00.000Z";
    const logPath = path.join(tmpHome, "cron", "runs", `${jobId}.jsonl`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // A future pre-execution marker (`started`) and a schema-corrupt statusless row
    // must NOT count as executed — an in-flight or crashed-mid-run fire stays retryable.
    fs.writeFileSync(
      logPath,
      `${JSON.stringify({ sessionKey: key, status: "started" })}\n` +
        `${JSON.stringify({ sessionKey: key })}\n`,
      "utf-8",
    );
    expect(hasRunLogEntry(jobId, key)).toBe(false);

    // Once a terminal outcome for the SAME key lands, the guard matches.
    fs.appendFileSync(logPath, `${JSON.stringify({ sessionKey: key, status: "success" })}\n`, "utf-8");
    expect(hasRunLogEntry(jobId, key)).toBe(true);
  });

  it("skips a corrupt line and still finds a real match on another line", async () => {
    const { hasRunLogEntry } = await importJobs();
    const jobId = "corrupt-job";
    const logPath = path.join(tmpHome, "cron", "runs", `${jobId}.jsonl`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // A truncated/garbage line followed by a valid one — the bad line must not throw
    // or mask the good line.
    fs.writeFileSync(
      logPath,
      `{"sessionKey":"cron:corrupt-job:a"  <-- broken\n` +
        `${JSON.stringify({ sessionKey: "cron:corrupt-job:good", status: "success" })}\n`,
      "utf-8",
    );
    expect(hasRunLogEntry(jobId, "cron:corrupt-job:good")).toBe(true);
    expect(hasRunLogEntry(jobId, "cron:corrupt-job:a")).toBe(false);
  });
});

describe("canonicalCronJobId (GRS-014d-fix2/3) — filesystem-identity canonicalization", () => {
  it("treats case, padding, and NFC/NFD unicode variants as one identity (they share one run-log file on macOS)", async () => {
    const { canonicalCronJobId } = await import("../jobs.js");
    expect(canonicalCronJobId("Workflow:WF-A")).toBe("workflow:wf-a");
    expect(canonicalCronJobId(" workflow:wf-a ")).toBe("workflow:wf-a");
    // NFC \u00e9 ("é" precomposed) vs NFD "e" + combining acute (\u0065\u0301):
    // different JS strings, ONE file name on macOS — must be one identity.
    const nfc = "workflow:caf\u00e9";
    const nfd = "workflow:cafe\u0301";
    expect(nfc).not.toBe(nfd); // sanity: the inputs really differ pre-canonicalization
    expect(canonicalCronJobId(nfc)).toBe(canonicalCronJobId(nfd));
    // Combined with case drift on the composed char.
    expect(canonicalCronJobId("Workflow:CAF\u00c9")).toBe(canonicalCronJobId(nfd));
  });
});
