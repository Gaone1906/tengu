import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/** Governor (step 4, 03-implementation-plan.md) — pins the runWebSession enforcement
 *  seam alongside the budget check: a "halt" decision must block the spawn before the
 *  engine runs, exactly like an over-budget employee. Usage is forced via a Claude
 *  statusline snapshot fixture, never a live 80% account state. */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-governor-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
for (const n of ["governed"]) fs.writeFileSync(path.join(tmpHome, "org", `${n}.yaml`), `name: ${n}\nengine: codex\nmodel: gpt-5.5\npersona: Governor fixture\n`);
const dbModule = await import("../../shared/db.js");
const pathsModule = await import("../../shared/paths.js");
const engineRuns: string[] = [];
const engineStub = { name: "stub", run: async (o: { sessionId?: string }) => { engineRuns.push(String(o.sessionId)); return { result: "ok" }; }, isAlive: () => false, kill: () => {}, killAll: () => {} };
const queueStub = { enqueue: async (_k: string, fn: () => Promise<void>) => { await fn(); }, clearCancelled: () => {}, clearQueue: () => {}, pauseQueue: () => {}, resumeQueue: () => {}, getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s };
const apiCtx = {
  getConfig: () => ({ gateway: {}, sessions: {}, engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } }, governor: {} }),
  connectors: new Map(), startTime: Date.now(), gatewayAuthToken: "test-token", emit: () => {},
  sessionManager: { getEngines: () => new Map(), getEngine: () => engineStub, getQueue: () => queueStub },
} as unknown as import("../api.js").ApiContext;
let api: typeof import("../api.js"), reg: typeof import("../../sessions/registry.js");
beforeAll(async () => {
  [api, reg] = await Promise.all([import("../api.js"), import("../../sessions/registry.js")]);
  dbModule.initDb();
  fs.mkdirSync(pathsModule.CLAUDE_LIMITS_DIR, { recursive: true });
});

/** Write a fake Claude statusline snapshot so readLocalGovernorTelemetry() picks it up
 *  without touching the real filesystem or network. */
function writeSnapshot(fiveHourPct: number, sevenDayPct = 0) {
  const file = path.join(pathsModule.CLAUDE_LIMITS_DIR, `snap-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    captured_at: new Date().toISOString(),
    rate_limits: {
      five_hour: { used_percentage: fiveHourPct, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: sevenDayPct, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
  }));
}

const blocked = (id: string) => reg.getMessages(id).some((m) => m.content.startsWith("⛔"));

async function spawn(): Promise<string> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ prompt: "probe", employee: "governed" }))]),
    { method: "POST", url: "/api/sessions", headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token" } });
  let body = "";
  const res = { writeHead() { return this; }, setHeader() { return this; }, end(b?: Buffer | string) { if (b) body += b.toString(); } } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, apiCtx);
  const id = JSON.parse(body).id as string;
  for (let i = 0; i < 300 && !engineRuns.includes(id) && !blocked(id); i++) await new Promise((r) => setTimeout(r, 10));
  return id;
}

describe("usage governor enforcement", () => {
  it("runWebSession blocks the spawn when 5-hour usage is over the default 80% threshold", async () => {
    writeSnapshot(95, 0);
    const id = await spawn();
    expect(engineRuns).not.toContain(id);
    expect(blocked(id)).toBe(true);
    expect(reg.getSession(id)?.status).toBe("error");
    expect(reg.getMessages(id).find((m) => m.content.startsWith("⛔"))?.content).toMatch(/governor/i);
  });

  it("runWebSession runs when usage is under threshold", async () => {
    writeSnapshot(10, 5);
    const id = await spawn();
    expect(engineRuns).toContain(id);
  });
});
