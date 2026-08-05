import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-experiments-routes-"));
process.env.JINN_HOME = home;

type Api = typeof import("../api.js");
let api: Api;
let db: import("better-sqlite3").Database;
let loadJobs: typeof import("../../cron/jobs.js").loadJobs;
let saveJobs: typeof import("../../cron/jobs.js").saveJobs;

const metrics = [
  { name: "activation", unit: "%", howToMeasure: "Read the activation dashboard." },
  { name: "retention", unit: "%", howToMeasure: "Read the day-seven cohort." },
];

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) { status = nextStatus; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get text() { return Buffer.concat(chunks).toString("utf-8"); },
  };
}

const context = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  jinnHome: home,
  gatewayAuthToken: "test-token",
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

async function request(method: string, target: string, body?: unknown): Promise<{ status: number; body: any }> {
  const encoded = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(encoded ? [Buffer.from(encoded)] : []), {
    method,
    url: target,
    headers: {
      host: "gateway.test",
      authorization: "Bearer test-token",
      ...(encoded ? { "content-type": "application/json" } : {}),
    },
  });
  const capture = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], capture.res, context);
  return { status: capture.status, body: JSON.parse(capture.text) };
}

async function create(checkIn?: { schedule: string }) {
  return request("POST", "/api/experiments", {
    name: "Onboarding clarity",
    hypothesis: "A smaller first step will improve activation.",
    baseline: { activation: 21, retention: 38 },
    metrics,
    horizonDays: 30,
    ...(checkIn ? { checkIn } : {}),
  });
}

beforeAll(async () => {
  api = await import("../api.js");
  const database = await import("../../shared/db.js");
  db = database.initDb();
  ({ loadJobs, saveJobs } = await import("../../cron/jobs.js"));
});

beforeEach(() => {
  db.prepare("DELETE FROM experiment_readings").run();
  db.prepare("DELETE FROM experiment_metrics").run();
  db.prepare("DELETE FROM experiments").run();
  saveJobs([]);
});

describe("Experiments HTTP routes", () => {
  it("creates, gets, and lists a running experiment with its metrics", async () => {
    const created = await create();
    expect(created).toMatchObject({
      status: 201,
      body: { experiment: { id: expect.stringMatching(/^exp_[0-9a-f]{12}$/), status: "running", metrics } },
    });

    const id = created.body.experiment.id;
    expect(await request("GET", `/api/experiments/${id}`)).toMatchObject({
      status: 200,
      body: { experiment: { id, metrics } },
    });
    expect(await request("GET", "/api/experiments?status=running")).toMatchObject({
      status: 200,
      body: { experiments: [{ id, status: "running" }] },
    });
  });

  it("returns 400 for an undeclared metric and returns valid readings chronologically", async () => {
    const id = (await create()).body.experiment.id;
    expect((await request("POST", `/api/experiments/${id}/readings`, {
      at: "2026-08-02T12:00:00.000Z", metric: "undeclared", value: 99,
    })).status).toBe(400);
    await request("POST", `/api/experiments/${id}/readings`, {
      at: "2026-08-03T12:00:00.000Z", metric: "activation", value: 25,
    });
    await request("POST", `/api/experiments/${id}/readings`, {
      at: "2026-08-01T12:00:00.000Z", metric: "activation", value: 23,
    });

    const detail = await request("GET", `/api/experiments/${id}`);
    expect(detail.body.experiment.readings.map((reading: { at: string }) => reading.at)).toEqual([
      "2026-08-01T12:00:00.000Z",
      "2026-08-03T12:00:00.000Z",
    ]);
  });

  it("updates while running, concludes, disables check-in, and then returns 409 for edits", async () => {
    const created = await create({ schedule: "0 9 * * 1" });
    const id = created.body.experiment.id;
    expect(loadJobs()).toMatchObject([{ id: created.body.experiment.checkInCronJobId, enabled: true }]);

    expect(await request("PATCH", `/api/experiments/${id}`, {
      name: "Revised clarity",
      hypothesis: "A revised first step will improve activation.",
      horizonDays: 45,
      metrics,
    })).toMatchObject({ status: 200, body: { experiment: { name: "Revised clarity", horizonDays: 45 } } });
    expect(await request("POST", `/api/experiments/${id}/conclude`, {
      outcome: "win",
      note: "Activation improved without hurting retention.",
    })).toMatchObject({
      status: 200,
      body: { experiment: { status: "concluded", verdict: { outcome: "win", concludedAt: expect.any(String) } } },
    });
    expect(loadJobs()).toMatchObject([{ id: created.body.experiment.checkInCronJobId, enabled: false }]);
    expect((await request("PATCH", `/api/experiments/${id}`, { horizonDays: 60 })).status).toBe(409);
  });

  it("rejects a broken schedule without leaving an experiment or cron job", async () => {
    expect((await create({ schedule: "broken" })).status).toBe(400);
    expect((await request("GET", "/api/experiments")).body.experiments).toEqual([]);
    expect(loadJobs()).toEqual([]);
  });
});
