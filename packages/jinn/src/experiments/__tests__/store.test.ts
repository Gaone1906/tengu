import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-experiments-store-"));
process.env.JINN_HOME = home;

type Store = typeof import("../store.js");
let store: Store;
let db: import("better-sqlite3").Database;

const metrics = [
  { name: "activation", unit: "%", howToMeasure: "Read the activation dashboard." },
  { name: "retention", unit: "%", howToMeasure: "Read the day-seven cohort." },
];

beforeAll(async () => {
  store = await import("../store.js");
  db = (await import("../../shared/db.js")).initDb();
});

function createFixture(name: string) {
  const result = store.createExperiment({
    name,
    hypothesis: "A smaller first step will improve activation.",
    baseline: { activation: 21, retention: 38 },
    metrics,
    horizonDays: 30,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  return result.value;
}

describe("experiment store", () => {
  it("creates the experiment tables during database initialization", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'experiment%' ORDER BY name",
    ).pluck().all();

    expect(tables).toEqual(["experiment_metrics", "experiment_readings", "experiments"]);
  });

  it("creates a running experiment and returns its declared metrics", () => {
    const experiment = createFixture("Onboarding clarity");

    expect(experiment).toMatchObject({
      id: expect.stringMatching(/^exp_[0-9a-f]{12}$/),
      name: "Onboarding clarity",
      status: "running",
      horizonDays: 30,
      metrics,
      readings: [],
    });
    expect(store.getExperiment(experiment.id)).toEqual({ ok: true, value: experiment });
  });

  it("appends readings, rejects undeclared metrics, and returns readings chronologically", () => {
    const experiment = createFixture("Reading order");

    const later = store.recordReading(experiment.id, {
      at: "2026-08-03T12:00:00.000Z",
      metric: "activation",
      value: 25,
      note: "Second check-in",
    });
    const earlier = store.recordReading(experiment.id, {
      at: "2026-08-01T12:00:00.000Z",
      metric: "activation",
      value: 23,
    });
    const invalid = store.recordReading(experiment.id, {
      at: "2026-08-02T12:00:00.000Z",
      metric: "undeclared",
      value: 99,
    });

    expect(later).toMatchObject({ ok: true, value: { metric: "activation", value: 25, note: "Second check-in" } });
    expect(earlier).toMatchObject({ ok: true, value: { metric: "activation", value: 23 } });
    expect(invalid).toMatchObject({ ok: false, reason: "invalid" });
    const fetched = store.getExperiment(experiment.id);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.value.readings.map((reading) => reading.at)).toEqual([
        "2026-08-01T12:00:00.000Z",
        "2026-08-03T12:00:00.000Z",
      ]);
    }
    expect("updateReading" in store).toBe(false);
    expect("deleteReading" in store).toBe(false);
  });

  it("edits the allowed fields while running and preserves the baseline", () => {
    const experiment = createFixture("Editable experiment");
    const updated = store.updateExperiment(experiment.id, {
      name: "Edited experiment",
      hypothesis: "The revised prompt will improve activation.",
      horizonDays: 45,
      metrics: [
        ...metrics,
        { name: "completion", howToMeasure: "Read completed onboarding sessions." },
      ],
    });

    expect(updated).toMatchObject({
      ok: true,
      value: {
        name: "Edited experiment",
        hypothesis: "The revised prompt will improve activation.",
        horizonDays: 45,
        baseline: { activation: 21, retention: 38 },
        metrics: [
          ...metrics,
          { name: "completion", howToMeasure: "Read completed onboarding sessions." },
        ],
      },
    });
  });

  it("concludes with a verdict and refuses later edits", () => {
    const experiment = createFixture("Concluded experiment");
    const concluded = store.concludeExperiment(experiment.id, {
      outcome: "win",
      note: "Activation improved without hurting retention.",
    });

    expect(concluded).toMatchObject({
      ok: true,
      value: {
        status: "concluded",
        verdict: {
          outcome: "win",
          note: "Activation improved without hurting retention.",
          concludedAt: expect.any(String),
        },
      },
    });
    expect(store.updateExperiment(experiment.id, { horizonDays: 60 })).toMatchObject({
      ok: false,
      reason: "conflict",
    });
  });
});
