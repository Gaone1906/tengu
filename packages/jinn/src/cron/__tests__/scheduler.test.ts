import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CronJob, JinnConfig, Connector } from "../../shared/types.js";

// Capture the callback node-cron would invoke on a scheduled tick so we can fire it
// manually. cron.schedule/validate are stubbed; stopScheduler needs a `.stop()`.
let scheduledCallback: (() => void) | undefined;
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expr: string, cb: () => void) => {
      scheduledCallback = cb;
      return { stop: vi.fn() };
    }),
    validate: vi.fn(() => true),
  },
}));

// Stub the runner so we assert HOW it is invoked, not what it does.
vi.mock("../runner.js", () => ({ runCronJob: vi.fn().mockResolvedValue(undefined) }));

const job: CronJob = {
  id: "test-job",
  name: "Test Job",
  enabled: true,
  schedule: "0 * * * *",
  prompt: "do something",
};

// findJob() loads jobs from disk — stub loadJobs to return our fixture.
vi.mock("../jobs.js", () => ({
  loadJobs: vi.fn(() => [job]),
  saveJobs: vi.fn(),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { startScheduler, triggerCronJob } from "../scheduler.js";
import { runCronJob } from "../runner.js";

const sessionManager = {} as any;
const config = { engines: { default: "claude" } } as unknown as JinnConfig;
const connectors = new Map<string, Connector>();

beforeEach(() => {
  vi.clearAllMocks();
  scheduledCallback = undefined;
});

describe("scheduler — manual vs scheduled fire identity (GRS-003b-2a / GRS-003b-1)", () => {
  it("triggerCronJob (manual /cron run) passes NO fireIso — never opted into the single-shot guard", async () => {
    startScheduler([], sessionManager, config, connectors); // set module vars, schedule nothing

    const result = await triggerCronJob("test-job");

    expect(result).toEqual(job);
    expect(runCronJob).toHaveBeenCalledTimes(1);
    const call = (runCronJob as any).mock.calls[0];
    // The opts carry the workflow fire handler slot (GRS-014d) but NO fireIso — a
    // manual trigger is a fresh fire by definition, never opted into the single-shot guard.
    expect(call[4]?.fireIso).toBeUndefined();
  });

  it("a scheduled tick DOES pass a deterministic per-fire fireIso", () => {
    startScheduler([job], sessionManager, config, connectors); // schedules the job, captures cb
    expect(scheduledCallback).toBeTypeOf("function");

    scheduledCallback!(); // simulate node-cron firing the tick

    expect(runCronJob).toHaveBeenCalledTimes(1);
    const opts = (runCronJob as any).mock.calls[0][4];
    expect(opts).toBeDefined();
    expect(opts.fireIso).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/);
  });
});
