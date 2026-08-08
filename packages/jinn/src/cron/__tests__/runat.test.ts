import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob, JinnConfig, Connector } from "../../shared/types.js";

/**
 * One-shot "runAt" cron kind (docs/tengu/03-implementation-plan.md step 6):
 * the governor's resume needs a job that fires exactly once at an absolute
 * timestamp, not on a recurring expression. Uses a stubbed near-future
 * `runAt` (~2 minutes, per the task) and fake timers rather than a real wait.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tmpHome: string;
const prevHome = process.env.JINN_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-cron-runat-"));
  process.env.JINN_HOME = tmpHome;
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(async () => {
  const { stopScheduler } = await import("../scheduler.js");
  stopScheduler();
  vi.useRealTimers();
  if (prevHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = prevHome;
  vi.resetModules();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sessionManager = {} as any;
const config = { engines: { default: "claude" } } as unknown as JinnConfig;
const connectors = new Map<string, Connector>();

describe("cron/validation.ts — 'runAt' kind", () => {
  it("accepts a finite ISO runAt and rejects a missing/invalid one", async () => {
    const { validateCronSchedule } = await import("../validation.js");
    const nearFuture = new Date(Date.now() + 2 * 60_000).toISOString();
    expect(validateCronSchedule({ schedule: "", kind: "runAt", runAt: nearFuture })).toEqual([]);
    expect(validateCronSchedule({ schedule: "", kind: "runAt", runAt: "not-a-date" }))
      .toEqual([{ field: "runAt", message: "runAt must be a finite ISO-8601 timestamp" }]);
    expect(validateCronSchedule({ schedule: "", kind: "runAt" }))
      .toEqual([{ field: "runAt", message: "runAt must be a finite ISO-8601 timestamp" }]);
    // kind absent (or "schedule") still validates the cron expression as before —
    // adding "runAt" support must not change default behavior for existing jobs.
    expect(validateCronSchedule({ schedule: "not a cron expr" }).length).toBeGreaterThan(0);
  });
});

describe("cron/scheduler.ts — one-shot 'runAt' fire", () => {
  it("fires exactly once, ~2 minutes out, resumes by sessionKey (not a fresh spawn), and disables itself", async () => {
    const { startScheduler } = await import("../scheduler.js");
    const { loadJobs, saveJobs } = await import("../jobs.js");
    const resumeSession = vi.fn(async () => {});

    const runAt = new Date(Date.now() + 2 * 60_000).toISOString();
    const job: CronJob = {
      id: "governor-resume-sess-abc",
      name: "Governor resume — engineer — JIN-1.2",
      enabled: true,
      kind: "runAt",
      schedule: "",
      runAt,
      resumeSessionKey: "session-key-abc",
      prompt: "resume",
    };
    saveJobs([job]); // the source of truth disableOneShotJob reads back from

    startScheduler([job], sessionManager, config, connectors, undefined, resumeSession);

    // Not due yet.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resumeSession).not.toHaveBeenCalled();

    // Past the scheduled instant — the resume fires.
    await vi.advanceTimersByTimeAsync(65_000);
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).toHaveBeenCalledWith("session-key-abc", "governor-resume-sess-abc");

    // Single-fire: disabled on disk so a later boot never refires it.
    const persisted = loadJobs().find((j) => j.id === "governor-resume-sess-abc");
    expect(persisted?.enabled).toBe(false);

    // Advancing further never fires it again.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it("catches up a fire that was missed during downtime — a past runAt fires almost immediately on the next boot", async () => {
    const { startScheduler } = await import("../scheduler.js");
    const { saveJobs } = await import("../jobs.js");
    const resumeSession = vi.fn(async () => {});

    const pastRunAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const job: CronJob = {
      id: "governor-resume-missed",
      name: "Governor resume — missed window",
      enabled: true,
      kind: "runAt",
      schedule: "",
      runAt: pastRunAt,
      resumeSessionKey: "session-key-missed",
      prompt: "resume",
    };
    saveJobs([job]);

    // Simulates a gateway restart: startScheduler recomputes the delay from
    // the persisted runAt, which is already in the past, at boot.
    startScheduler([job], sessionManager, config, connectors, undefined, resumeSession);
    await vi.advanceTimersByTimeAsync(0);

    expect(resumeSession).toHaveBeenCalledWith("session-key-missed", "governor-resume-missed");
  });

  it("without a resumeSession handler wired, logs and disables rather than throwing", async () => {
    const { startScheduler } = await import("../scheduler.js");
    const { loadJobs, saveJobs } = await import("../jobs.js");

    const runAt = new Date(Date.now() + 1000).toISOString();
    const job: CronJob = {
      id: "governor-resume-no-handler",
      name: "Governor resume — no handler",
      enabled: true,
      kind: "runAt",
      schedule: "",
      runAt,
      resumeSessionKey: "session-key-orphan",
      prompt: "resume",
    };
    saveJobs([job]);

    startScheduler([job], sessionManager, config, connectors); // no resumeSession arg
    await vi.advanceTimersByTimeAsync(2000);

    const persisted = loadJobs().find((j) => j.id === "governor-resume-no-handler");
    expect(persisted?.enabled).toBe(false);
  });
});
