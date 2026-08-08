import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/** Continuous loop (step 8, 03-implementation-plan.md; D19 — bypass the
 *  upstream todo-dispatcher, assignment is a deterministic query). Exercises
 *  the real `/api/internal/hook` relay: a Stop hook must dispatch the next
 *  open unit for the session's employee onto the SAME session when the
 *  governor says "run", and must never do so for an `interactive: true`
 *  employee (the council, D11) — it would answer its own clarifying
 *  questions. */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-continuous-loop-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "org", "engineer.yaml"),
  "name: engineer\nengine: codex\nmodel: gpt-5.5\npersona: Continuous-loop fixture\n",
);
fs.writeFileSync(
  path.join(tmpHome, "org", "council.yaml"),
  "name: council\nengine: codex\nmodel: gpt-5.5\npersona: Council fixture\ninteractive: true\n",
);

const dbModule = await import("../../shared/db.js");
const pathsModule = await import("../../shared/paths.js");
const { HookRegistry } = await import("../hook-registry.js");

const engineRuns: string[] = [];
const engineStub = {
  name: "stub",
  run: async (o: { sessionId?: string }) => {
    engineRuns.push(String(o.sessionId));
    return { result: "ok" };
  },
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const queueStub = {
  enqueue: async (_k: string, fn: () => Promise<void>) => { await fn(); },
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_k: string, s: string) => s,
};
const hookRegistry = new HookRegistry();
const apiCtx = {
  getConfig: () => ({ gateway: {}, sessions: {}, engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } }, governor: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: { getEngines: () => new Map(), getEngine: () => engineStub, getQueue: () => queueStub },
  hookRegistry,
  hookSecret: "sek",
} as unknown as import("../api.js").ApiContext;

let api: typeof import("../api.js");
let reg: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");

beforeAll(async () => {
  [api, reg, store] = await Promise.all([
    import("../api.js"),
    import("../../sessions/registry.js"),
    import("../../work-items/store.js"),
  ]);
  dbModule.initDb();
  fs.mkdirSync(pathsModule.CLAUDE_LIMITS_DIR, { recursive: true });
});

/** Governor-friendly snapshot — well under every default threshold. */
function writeLowUsageSnapshot(): void {
  const file = path.join(pathsModule.CLAUDE_LIMITS_DIR, `snap-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    captured_at: new Date().toISOString(),
    rate_limits: {
      five_hour: { used_percentage: 5, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 5, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
  }));
}

async function postStopHook(jinnSessionId: string): Promise<void> {
  const body = JSON.stringify({
    jinnSessionId,
    hook: { hook_event_name: "Stop", session_id: `claude-${jinnSessionId}` },
  });
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method: "POST",
    url: "/api/internal/hook",
    headers: { host: "localhost", "content-type": "application/json", "x-jinn-hook-secret": "sek" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  let resBody = "";
  const res = {
    writeHead() { return this; },
    setHeader() { return this; },
    end(b?: Buffer | string) { if (b) resBody += b.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, apiCtx);
  expect(JSON.parse(resBody)).toEqual({ message: "ok" });
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("continuous loop — Stop hook dispatch", () => {
  it("dispatches the next open unit automatically when the governor says run", async () => {
    writeLowUsageSnapshot();
    const session = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: `continuous-loop:${Math.random()}`,
      employee: "engineer",
    });
    expect(session.status).toBe("idle");

    const item = store.createWorkItem({
      title: "Wire the next unit",
      status: "backlog",
      assignee: "engineer",
      priority: 3,
    });

    await postStopHook(session.id);
    await waitFor(() => engineRuns.includes(session.id));

    expect(engineRuns).toContain(session.id);
    expect(reg.getSession(session.id)?.workItemId).toBe(item.id);
  });

  it("does not auto-continue an interactive:true employee (the council)", async () => {
    writeLowUsageSnapshot();
    const session = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: `continuous-loop-interactive:${Math.random()}`,
      employee: "council",
    });
    expect(session.status).toBe("idle");

    store.createWorkItem({
      title: "Council should not grab this",
      status: "backlog",
      assignee: "council",
      priority: 3,
    });

    const before = engineRuns.length;
    await postStopHook(session.id);
    // Give the (would-be) dispatch a moment — there is nothing to poll FOR
    // (a non-event), so this is a bounded wait rather than a race.
    await new Promise((r) => setTimeout(r, 100));

    expect(engineRuns.length).toBe(before);
    expect(reg.getSession(session.id)?.workItemId).toBeFalsy();
  });

  it("does not dispatch when the governor halts on 5-hour usage", async () => {
    const overLimitFile = path.join(pathsModule.CLAUDE_LIMITS_DIR, `snap-halt-${Date.now()}.json`);
    fs.writeFileSync(overLimitFile, JSON.stringify({
      captured_at: new Date().toISOString(),
      rate_limits: {
        five_hour: { used_percentage: 95, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: 5, resets_at: Math.floor(Date.now() / 1000) + 86400 },
      },
    }));
    const session = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: `continuous-loop-halted:${Math.random()}`,
      employee: "engineer",
    });

    store.createWorkItem({
      title: "Should wait for the governor",
      status: "backlog",
      assignee: "engineer",
      priority: 3,
    });

    const before = engineRuns.length;
    await postStopHook(session.id);
    await new Promise((r) => setTimeout(r, 100));

    expect(engineRuns.length).toBe(before);
    fs.rmSync(overLimitFile);
  });
});
