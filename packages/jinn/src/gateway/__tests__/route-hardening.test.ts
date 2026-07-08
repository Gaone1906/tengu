import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ServerResponse } from "node:http";

/**
 * Route-level tests for two hardened GET handlers in ../api.ts:
 *   - GET /api/cron/:id/runs   → skips corrupt JSONL lines, returns the good rows
 *   - GET /api/org/departments/:name/board → 500s on a corrupt board.json
 *
 * Both handlers resolve their on-disk paths from CRON_RUNS / ORG_DIR in
 * ../../shared/paths.js, so we mock that module to point at a temp dir. The
 * handlers return early (before touching session/connector state), so a minimal
 * ApiContext stub is sufficient. We drive handleApiRequest directly with fake
 * req/res objects — no HTTP server boot required.
 */

// Initialized at module load (before the mocked paths.js getters can be hit by
// import-time consumers like usageAwareness.ts). Re-pointed per test in beforeEach.
const bootHome = fs.mkdtempSync(path.join(os.tmpdir(), "route-harden-boot-"));
let tmpHome = bootHome;
let cronRunsDir = path.join(tmpHome, "cron", "runs");
let cronJobsFile = path.join(tmpHome, "cron", "jobs.json");
let orgDir = path.join(tmpHome, "org");

vi.mock("../../shared/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/paths.js")>();
  return {
    ...actual,
    // Only override the two dirs the target routes read. JINN_HOME is left as
    // the real value so import-time consumers don't break.
    get CRON_RUNS() {
      return cronRunsDir;
    },
    get CRON_JOBS() {
      return cronJobsFile;
    },
    get ORG_DIR() {
      return orgDir;
    },
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleApiRequest } from "../api.js";
import type { ApiContext } from "../api.js";

interface CapturedRes {
  res: ServerResponse;
  get status(): number;
  get body(): unknown;
}

function makeRes(): CapturedRes {
  let status = 200;
  let chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(method: string, urlPath: string) {
  return {
    method,
    url: urlPath,
    headers: { host: "localhost" },
  } as unknown as Parameters<typeof handleApiRequest>[0];
}

// Minimal context — the target routes return before reading these fields.
const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
} as unknown as ApiContext;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "route-harden-"));
  cronRunsDir = path.join(tmpHome, "cron", "runs");
  cronJobsFile = path.join(tmpHome, "cron", "jobs.json");
  orgDir = path.join(tmpHome, "org");
  fs.mkdirSync(cronRunsDir, { recursive: true });
  fs.mkdirSync(path.dirname(cronJobsFile), { recursive: true });
  fs.mkdirSync(orgDir, { recursive: true });
});

describe("GET /api/cron — read-tier summary scrubs prompt/env", () => {
  it("never returns cron prompt or env secrets from the backing route the MCP tool calls", async () => {
    fs.writeFileSync(path.join(cronRunsDir, "secret-job.jsonl"), JSON.stringify({ timestamp: "2026-07-06T08:00:00.000Z", status: "success", result: "ok" }) + "\n");
    fs.writeFileSync(
      cronJobsFile,
      JSON.stringify([
        {
          id: "secret-job",
          name: "Secret Job",
          schedule: "0 8 * * *",
          enabled: true,
          employee: "ops",
          prompt: "CRON_PROMPT_SECRET_SHOULD_NOT_REACH_MCP",
          env: { API_KEY: "CRON_ENV_SECRET_SHOULD_NOT_REACH_MCP" },
        },
      ]),
    );

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(JSON.stringify(cap.body)).not.toContain("CRON_PROMPT_SECRET_SHOULD_NOT_REACH_MCP");
    expect(JSON.stringify(cap.body)).not.toContain("CRON_ENV_SECRET_SHOULD_NOT_REACH_MCP");
    expect(cap.body).toEqual([
      {
        id: "secret-job",
        name: "Secret Job",
        schedule: "0 8 * * *",
        enabled: true,
        employee: "ops",
        engine: null,
        timezone: null,
        lastRun: { timestamp: "2026-07-06T08:00:00.000Z", status: "success" },
      },
    ]);
  });

  it("never returns run-log prompt/env/body secrets through lastRun or run history", async () => {
    const promptSecret = "CANARY-REQA-CRON-RUN-PROMPT";
    const envSecret = "CANARY-REQA-CRON-RUN-ENV";
    const run = {
      id: "run-secret",
      jobId: "secret-job",
      timestamp: "2026-07-06T08:00:00.000Z",
      sessionKey: "cron:secret-job:2026-07-06T08:00:00.000Z",
      status: "error",
      exitCode: 1,
      durationMs: 321,
      prompt: `private prompt ${promptSecret}`,
      env: { API_KEY: envSecret },
      command: `run with ${promptSecret}`,
      result: `result echoed ${promptSecret}`,
      resultPreview: `preview echoed ${promptSecret}`,
      error: `error echoed ${envSecret}`,
      message: `message echoed ${promptSecret}`,
    };
    fs.writeFileSync(path.join(cronRunsDir, "secret-job.jsonl"), JSON.stringify(run) + "\n");
    fs.writeFileSync(
      cronJobsFile,
      JSON.stringify([{ id: "secret-job", name: "Secret Job", schedule: "0 8 * * *", enabled: true }]),
    );

    const listCap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron"), listCap.res, ctx);
    const historyCap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/secret-job/runs"), historyCap.res, ctx);

    expect(listCap.status).toBe(200);
    expect(historyCap.status).toBe(200);
    for (const body of [listCap.body, historyCap.body]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(promptSecret);
      expect(serialized).not.toContain(envSecret);
      expect(serialized).not.toContain("prompt");
      expect(serialized).not.toContain("env");
      expect(serialized).not.toContain("command");
      expect(serialized).not.toContain("result echoed");
      expect(serialized).not.toContain("preview echoed");
      expect(serialized).not.toContain("error echoed");
      expect(serialized).not.toContain("message echoed");
    }
    const safeRun = {
      id: "run-secret",
      jobId: "secret-job",
      timestamp: "2026-07-06T08:00:00.000Z",
      sessionKey: "cron:secret-job:2026-07-06T08:00:00.000Z",
      status: "error",
      exitCode: 1,
      durationMs: 321,
    };
    expect((listCap.body as Array<{ lastRun: unknown }>)[0].lastRun).toEqual(safeRun);
    expect(historyCap.body).toEqual([safeRun]);
  });

  it("coerces allowed run-log keys so their values cannot carry secrets", async () => {
    const statusSecret = "CANARY-REQA-ALLOWED-STATUS";
    const sessionSecret = "CANARY-REQA-ALLOWED-SESSION";
    const nestedSecret = "CANARY-REQA-ALLOWED-DURATION";
    const timestampSecret = "CANARY-REQA-ALLOWED-TIMESTAMP";
    const run = {
      id: "run-secret",
      jobId: "secret-job",
      timestamp: `not-a-timestamp ${timestampSecret}`,
      startedAt: { secret: timestampSecret },
      finishedAt: ["2026-07-06T08:00:00.000Z", timestampSecret],
      sessionKey: `cron:secret-job:${"x".repeat(260)}${sessionSecret}:2026-07-06T08:00:00.000Z`,
      status: `success ${statusSecret}`,
      exitCode: { secret: nestedSecret },
      durationMs: { value: 321, secret: nestedSecret },
      duration: [nestedSecret],
    };
    fs.writeFileSync(path.join(cronRunsDir, "secret-job.jsonl"), JSON.stringify(run) + "\n");
    fs.writeFileSync(
      cronJobsFile,
      JSON.stringify([{ id: "secret-job", name: "Secret Job", schedule: "0 8 * * *", enabled: true }]),
    );

    const listCap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron"), listCap.res, ctx);
    const historyCap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/secret-job/runs"), historyCap.res, ctx);

    expect(listCap.status).toBe(200);
    expect(historyCap.status).toBe(200);
    for (const body of [listCap.body, historyCap.body]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(statusSecret);
      expect(serialized).not.toContain(sessionSecret);
      expect(serialized).not.toContain(nestedSecret);
      expect(serialized).not.toContain(timestampSecret);
      expect(serialized).not.toContain("success CANARY");
      expect(serialized).not.toContain("not-a-timestamp");
      expect(serialized).not.toContain("duration");
    }
    const safeRun = { id: "run-secret", jobId: "secret-job" };
    expect((listCap.body as Array<{ lastRun: unknown }>)[0].lastRun).toEqual(safeRun);
    expect(historyCap.body).toEqual([safeRun]);
  });
});

afterEach(() => {
  if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

afterAll(() => {
  if (fs.existsSync(bootHome)) fs.rmSync(bootHome, { recursive: true, force: true });
});

describe("GET /api/cron/:id/runs — corrupt-line tolerance", () => {
  it("skips a dangling/corrupt JSONL line and returns the good rows, newest first", async () => {
    const good1 = JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", status: "success" });
    const good2 = JSON.stringify({ timestamp: "2026-01-02T00:00:00Z", status: "error" });
    // A crash mid-write can leave a half-written final line.
    const corrupt = '{"ts":"2026-01-03T00:00:00Z","ok"';
    fs.writeFileSync(path.join(cronRunsDir, "my-job.jsonl"), [good1, corrupt, good2].join("\n"));

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/my-job/runs"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body)).toBe(true);
    expect(cap.body).toEqual([
      { timestamp: "2026-01-02T00:00:00Z", status: "error" },
      { timestamp: "2026-01-01T00:00:00Z", status: "success" },
    ]);
  });

  it("honors ?limit=N, returning only the newest N runs", async () => {
    const lines = [1, 2, 3, 4].map((n) => JSON.stringify({ id: `run-${n}`, status: "success" }));
    fs.writeFileSync(path.join(cronRunsDir, "my-job.jsonl"), lines.join("\n") + "\n");

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/my-job/runs?limit=2"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([{ id: "run-4", status: "success" }, { id: "run-3", status: "success" }]);
  });

  it("returns [] when the run file does not exist", async () => {
    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/no-such-job/runs"), cap.res, ctx);
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([]);
  });
});

describe("GET /api/org/departments/:name/board — corrupt board.json", () => {
  it("returns 500 when board.json is not valid JSON", async () => {
    const deptDir = path.join(orgDir, "platform");
    fs.mkdirSync(deptDir, { recursive: true });
    fs.writeFileSync(path.join(deptDir, "board.json"), "{ this is not json ]");

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/org/departments/platform/board"), cap.res, ctx);

    expect(cap.status).toBe(500);
    expect(cap.body).toMatchObject({ error: expect.stringContaining("corrupt") });
  });

  it("returns 200 with the parsed board when board.json is valid", async () => {
    const deptDir = path.join(orgDir, "platform");
    fs.mkdirSync(deptDir, { recursive: true });
    const board = { todo: ["a"], in_progress: [], done: ["b"] };
    fs.writeFileSync(path.join(deptDir, "board.json"), JSON.stringify(board));

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/org/departments/platform/board"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(board);
  });
});
