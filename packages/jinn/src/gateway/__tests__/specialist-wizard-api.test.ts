import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Isolate JINN_HOME before any module that reads paths.js is imported.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-specialist-wizard-api-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

// The wizard's integration path (routes/specialists/new.tsx →
// POST /api/specialists → POST .../kb/learn → POST .../kb/teach/start →
// POST .../kb/teach/complete) runs the REAL knowledge-base/index.ts and
// knowledge-base/teaching.ts orchestration end to end — chunking, storage,
// manifest writes, transcript harvesting — with only the leaf ONNX embedding
// call replaced by a deterministic, near-instant fake (same substitution
// knowledge-base/__tests__/index.test.ts makes), so this stays a true
// integration test of the wizard's Lane A wiring, not a stub of it.
const embedCalls: string[] = [];
vi.mock("../../knowledge-base/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../knowledge-base/embeddings.js")>();
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => {
      embedCalls.push(...texts);
      return texts.map((text) => {
        const seed = crypto.createHash("sha1").update(text).digest();
        return Array.from({ length: actual.EMBEDDING_DIMENSIONS }, (_, i) => seed[i % seed.length] / 255);
      });
    }),
  };
});

fs.writeFileSync(
  path.join(tmpHome, "config.yaml"),
  yaml.dump({
    gateway: {},
    engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
    models: {
      claude: {
        default: "opus",
        models: [
          { id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "sonnet", label: "Sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
    },
    portal: { portalName: "Portal COO", setupComplete: true },
    connectors: {},
    mcp: {},
    sessions: {},
  }),
);

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Teaching = typeof import("../../knowledge-base/teaching.js");

let api: Api;
let registry: Registry;
let teaching: Teaching;
let repoRoot: string;

const apiCtx = {
  getConfig: () => yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")),
  reloadConfig: () => {},
  reloadOrg: vi.fn(),
  reloadConnectorInstances: async () => ({ reloaded: true }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: vi.fn(),
  sessionManager: {
    // No real engine is registered — the wizard still creates the session and
    // its kickoff message before hitting this, which is what the assertions
    // below check; dispatch itself is exactly the "slow session call" the
    // task brief says to mock out.
    getEngine: () => undefined,
    getEngines: () => new Map(),
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    setHeader() {
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
    get bodyText() {
      return Buffer.concat(chunks).toString("utf-8");
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    },
  };
}

async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return cap;
}

const AUTH = { authorization: "Bearer test-token" };

async function waitForManifest(name: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const res = await call("GET", `/api/specialists/${name}/kb`, undefined, AUTH);
    if (res.body?.exists) return;
    if (Date.now() - start > timeoutMs) throw new Error(`manifest for "${name}" never appeared`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  teaching = await import("../../knowledge-base/teaching.js");
  (await import("../../shared/db.js")).initDb();

  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-specialist-wizard-repo-"));
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "src", "index.ts"),
    "export function add(a: number, b: number): number {\n  return a + b\n}\n".repeat(20),
  );
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Acme Engine\n\nThis repo runs the acme pricing engine.\n".repeat(20));
});

describe("specialist creation wizard API (C6)", () => {
  it("walks submission → YAML written → learning phase → teaching phase, gated correctly throughout", async () => {
    // 1. Submit the wizard form.
    const create = await call(
      "POST",
      "/api/specialists",
      { name: "acme-eng", repo: repoRoot, model: "sonnet", effortLevel: "medium" },
      AUTH,
    );
    expect(create.status).toBe(201);
    expect(create.body.employee).toMatchObject({
      name: "acme-eng",
      department: "specialists",
      repo: repoRoot,
      model: "sonnet",
      effortLevel: "medium",
      interactive: true,
    });

    // The YAML actually landed where org.ts's read side (scanOrg) looks for it.
    const yamlPath = path.join(tmpHome, "org", "specialists", "acme-eng.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);
    const onDisk = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    expect(onDisk.repo).toBe(repoRoot);
    expect(onDisk.persona).toBeTruthy();

    // A duplicate name is rejected, not silently overwritten.
    const dup = await call("POST", "/api/specialists", { name: "acme-eng", repo: repoRoot }, AUTH);
    expect(dup.status).toBe(400);

    // Not yet ready: onboarding (interactive: true) still set, so the carousel/
    // round-table picker's `!!e.repo && !e.interactive` filter excludes it.
    const beforeLearn = await call("GET", "/api/org/employees/acme-eng", undefined, AUTH);
    expect(beforeLearn.body.interactive).toBe(true);

    // Teaching cannot start before learning has produced a manifest.
    const earlyTeach = await call("POST", "/api/specialists/acme-eng/kb/teach/start", undefined, AUTH);
    expect(earlyTeach.status).toBe(400);

    // 2. Trigger the learning phase — the REAL runLearningPhase (only its
    // embedding call is faked), fire-and-forget like the incremental route.
    const learn = await call("POST", "/api/specialists/acme-eng/kb/learn", undefined, AUTH);
    expect(learn.status).toBe(200);
    expect(learn.body).toMatchObject({ triggered: true, employee: "acme-eng" });

    await waitForManifest("acme-eng");
    const kb = await call("GET", "/api/specialists/acme-eng/kb", undefined, AUTH);
    expect(kb.body.exists).toBe(true);
    expect(kb.body.manifest.employeeName).toBe("acme-eng");
    expect(kb.body.manifest.repo).toBe(repoRoot);
    expect(kb.body.manifest.fileCount).toBeGreaterThan(0);
    expect(kb.body.manifest.chunkCount).toBeGreaterThan(0);
    const chunksIndexed = embedCalls.length;
    expect(chunksIndexed).toBeGreaterThan(0);

    // 3. Trigger the teaching phase kickoff — the REAL buildTeachingKickoffPrompt
    // (from Lane A's teaching.ts), a real session bound to the specialist, seeded
    // with that exact prompt as the opening user message.
    const teachStart = await call("POST", "/api/specialists/acme-eng/kb/teach/start", undefined, AUTH);
    expect(teachStart.status).toBe(201);
    const sessionId: string = teachStart.body.sessionId;
    expect(sessionId).toBeTruthy();

    const session = registry.getSession(sessionId);
    expect(session?.employee).toBe("acme-eng");
    const expectedPrompt = teaching.buildTeachingKickoffPrompt({ name: "acme-eng", repo: repoRoot });
    const messages = registry.getMessages(sessionId);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe(expectedPrompt);

    // Simulate the human answering the specialist's questions in chat.
    registry.insertMessage(sessionId, "assistant", "What's the deploy process for this repo?");
    registry.insertMessage(sessionId, "user", "We deploy via GitHub Actions on merge to main.");

    // Still not ready — teaching hasn't been harvested/completed yet.
    const midTeach = await call("GET", "/api/org/employees/acme-eng", undefined, AUTH);
    expect(midTeach.body.interactive).toBe(true);

    // 4. Complete the teaching phase — the REAL runTeachingPhase harvests the
    // transcript into `source: 'teaching'` chunks and the onboarding flag clears.
    const complete = await call("POST", "/api/specialists/acme-eng/kb/teach/complete", { sessionId }, AUTH);
    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({ employee: "acme-eng", ready: true });
    expect(complete.body.chunkCount).toBeGreaterThan(0);
    expect(embedCalls.length).toBeGreaterThan(chunksIndexed);

    // Now genuinely ready: interactive is cleared, repo is set — exactly the
    // condition the carousel/round-table picker gates on.
    const after = await call("GET", "/api/org/employees/acme-eng", undefined, AUTH);
    expect(after.body.interactive).toBeFalsy();
    expect(after.body.repo).toBe(repoRoot);
  });

  it("rejects an invalid creation body without writing anything", async () => {
    const noName = await call("POST", "/api/specialists", { repo: repoRoot }, AUTH);
    expect(noName.status).toBe(400);

    const noRepo = await call("POST", "/api/specialists", { name: "no-repo-eng" }, AUTH);
    expect(noRepo.status).toBe(400);
    expect(fs.existsSync(path.join(tmpHome, "org", "specialists", "no-repo-eng.yaml"))).toBe(false);

    const badModel = await call(
      "POST",
      "/api/specialists",
      { name: "bad-model-eng", repo: repoRoot, model: "not-a-real-model" },
      AUTH,
    );
    expect(badModel.status).toBe(400);
  });

  it("rejects unauthenticated creation", async () => {
    const anonymous = await call("POST", "/api/specialists", { name: "sneaky-eng", repo: repoRoot });
    expect(anonymous.status).toBe(403);
    expect(fs.existsSync(path.join(tmpHome, "org", "specialists", "sneaky-eng.yaml"))).toBe(false);
  });

  it("404s learning/teaching triggers for an unknown specialist", async () => {
    const learn = await call("POST", "/api/specialists/does-not-exist/kb/learn", undefined, AUTH);
    expect(learn.status).toBe(404);
    const teach = await call("POST", "/api/specialists/does-not-exist/kb/teach/start", undefined, AUTH);
    expect(teach.status).toBe(404);
  });
});
