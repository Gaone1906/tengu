import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-experiments-check-in-"));
process.env.JINN_HOME = home;

type CheckIn = typeof import("../check-in.js");
type Store = typeof import("../store.js");
type Jobs = typeof import("../../cron/jobs.js");
let checkIn: CheckIn;
let store: Store;
let jobs: Jobs;

const input = {
  name: "Activation check",
  hypothesis: "A clearer entry point will improve activation.",
  baseline: { activation: 20, completion: 31 },
  metrics: [
    { name: "activation", unit: "%", howToMeasure: "Read the activation dashboard." },
    { name: "completion", unit: "%", howToMeasure: "Read the completed-session report." },
  ],
  horizonDays: 21,
};

beforeAll(async () => {
  checkIn = await import("../check-in.js");
  store = await import("../store.js");
  jobs = await import("../../cron/jobs.js");
  (await import("../../shared/db.js")).initDb();
});

beforeEach(() => jobs.saveJobs([]));

describe("experiment check-in scheduling", () => {
  it("writes no cron job when checkIn is omitted", () => {
    const created = checkIn.createExperimentWithCheckIn(input);

    expect(created.ok).toBe(true);
    expect(jobs.loadJobs()).toEqual([]);
  });

  it("writes an enabled job whose prompt carries every measurement instruction", () => {
    const created = checkIn.createExperimentWithCheckIn(input, {
      schedule: "0 9 * * 1",
      employee: "analyst",
      timezone: "Europe/London",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [job] = jobs.loadJobs();
    expect(job).toMatchObject({
      id: created.value.checkInCronJobId,
      enabled: true,
      schedule: "0 9 * * 1",
      employee: "analyst",
      timezone: "Europe/London",
    });
    expect(job.prompt).toContain("Read the activation dashboard.");
    expect(job.prompt).toContain("Read the completed-session report.");
    expect(job.prompt).toContain("record_reading");
    expect(job.prompt).toContain(`id "${created.value.id}"`);
    expect(job.prompt).not.toContain("experimentId");
  });

  it("rejects an invalid cron expression before persisting the experiment", () => {
    const before = store.listExperiments().map((experiment) => experiment.id);

    const created = checkIn.createExperimentWithCheckIn(input, { schedule: "not a cron" });

    expect(created).toMatchObject({ ok: false, reason: "invalid" });
    expect(store.listExperiments().map((experiment) => experiment.id)).toEqual(before);
    expect(jobs.loadJobs()).toEqual([]);
  });

  it("disables the registered job when the experiment concludes", () => {
    const created = checkIn.createExperimentWithCheckIn(input, { schedule: "0 9 * * 1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const concluded = checkIn.concludeExperimentAndDisableCheckIn(created.value.id, {
      outcome: "inconclusive",
      note: "The result needs a longer horizon.",
    });

    expect(concluded).toMatchObject({ ok: true, value: { status: "concluded" } });
    expect(jobs.loadJobs()).toMatchObject([{ id: created.value.checkInCronJobId, enabled: false }]);
  });
});
