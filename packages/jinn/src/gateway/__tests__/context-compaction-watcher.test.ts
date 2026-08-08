/**
 * Context compaction watcher (docs/tengu/03-implementation-plan.md step 7).
 * Proves the explicit 80%-context trigger fires end to end: a real statusline
 * snapshot file joined to a real session row, run through the same
 * evaluateGovernor() the governor's spawn-time halt check uses, driving a
 * real /compact call — decoupled from chokidar's async file-watch timing by
 * testing `checkContextCompaction` (the pure per-tick decision pass)
 * directly, per session-telemetry.test.ts's fixture style.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Engine, EngineResult, Session } from "../../shared/types.js";

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let JINN_HOME_TMP: string;
let CLAUDE_DIR: string;
let createSession: (opts: { engine: string; source: string; sourceRef: string; model?: string }) => Session;
let updateSession: typeof import("../../sessions/registry.js").updateSession;
let checkContextCompaction: typeof import("../context-compaction-watcher.js").checkContextCompaction;

function writeSnapshot(sessionId: string, contextUsedPct: number, ageMs = 60_000): string {
  const file = path.join(CLAUDE_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    captured_at: new Date().toISOString(),
    rate_limits: {
      five_hour: { used_percentage: 10, resets_at: 4_102_444_800 },
      seven_day: { used_percentage: 5, resets_at: 4_102_444_800 },
    },
    context_window: { used_percentage: contextUsedPct },
  }));
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return file;
}

beforeAll(async () => {
  JINN_HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-context-compaction-watcher-"));
  CLAUDE_DIR = path.join(JINN_HOME_TMP, "tmp", "engine-limits", "claude");
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  process.env.JINN_HOME = JINN_HOME_TMP;
  ({ createSession, updateSession } = await import("../../sessions/registry.js"));
  (await import("../../shared/db.js")).initDb();
  ({ checkContextCompaction } = await import("../context-compaction-watcher.js"));
});

afterAll(() => {
  delete process.env.JINN_HOME;
  fs.rmSync(JINN_HOME_TMP, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(CLAUDE_DIR)) fs.rmSync(path.join(CLAUDE_DIR, f));
});

function makeIdleSession(): Session {
  const session = createSession({ engine: "claude", source: "web", sourceRef: `sref-${Math.random()}`, model: "sonnet" });
  return updateSession(session.id, { engineSessionId: "native-sess-1", status: "idle" }) ?? session;
}

function fakeEngine(runImpl: (opts: { prompt: string }) => EngineResult) {
  const calls: string[] = [];
  const engine: Engine = {
    name: "claude",
    run: async (opts) => { calls.push(opts.prompt); return runImpl(opts); },
  };
  return { engine, calls };
}

describe("checkContextCompaction — the explicit 80%-context trigger", () => {
  it("triggers /compact for an idle session at exactly 80% context usage", async () => {
    const session = makeIdleSession();
    writeSnapshot(session.id, 80);
    const { engine, calls } = fakeEngine(() => ({ result: "", sessionId: "native-sess-1" }));

    const pending = checkContextCompaction({ dir: CLAUDE_DIR, getEngine: () => engine });
    expect(pending).toHaveLength(1);
    const results = await Promise.all(pending);

    expect(calls).toEqual(["/compact"]);
    expect(results[0]).toEqual({ compacted: true, handoffReinjected: false });
  });

  it("does NOT trigger below the 80% threshold", async () => {
    const session = makeIdleSession();
    writeSnapshot(session.id, 79);
    const { engine, calls } = fakeEngine(() => ({ result: "", sessionId: "native-sess-1" }));

    const pending = checkContextCompaction({ dir: CLAUDE_DIR, getEngine: () => engine });
    expect(pending).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("does NOT trigger for a session mid-turn (status !== idle) — would race the live turn's resolver", async () => {
    const session = createSession({ engine: "claude", source: "web", sourceRef: `sref-${Math.random()}`, model: "sonnet" });
    updateSession(session.id, { engineSessionId: "native-sess-1", status: "running" });
    writeSnapshot(session.id, 95);
    const { engine, calls } = fakeEngine(() => ({ result: "", sessionId: "native-sess-1" }));

    const pending = checkContextCompaction({ dir: CLAUDE_DIR, getEngine: () => engine });
    expect(pending).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("respects an operator-configured contextCompactPct threshold instead of the 80% default", async () => {
    const session = makeIdleSession();
    writeSnapshot(session.id, 65);
    const { engine, calls } = fakeEngine(() => ({ result: "", sessionId: "native-sess-1" }));

    const belowCustom = checkContextCompaction({ dir: CLAUDE_DIR, getEngine: () => engine, governorConfig: () => ({ contextCompactPct: 70 }) });
    expect(belowCustom).toHaveLength(0);

    const aboveCustom = checkContextCompaction({ dir: CLAUDE_DIR, getEngine: () => engine, governorConfig: () => ({ contextCompactPct: 60 }) });
    expect(aboveCustom).toHaveLength(1);
    await Promise.all(aboveCustom);
    expect(calls).toEqual(["/compact"]);
  });

  it("dedupes a session already mid-compaction across repeated ticks via the shared inFlight set", async () => {
    const session = makeIdleSession();
    writeSnapshot(session.id, 90);
    let resolveRun!: (r: EngineResult) => void;
    const engine: Engine = {
      name: "claude",
      run: () => new Promise((resolve) => { resolveRun = resolve; }),
    };
    const inFlight = new Set<string>();

    const firstTick = checkContextCompaction({ dir: CLAUDE_DIR, getEngine: () => engine }, inFlight);
    expect(firstTick).toHaveLength(1);

    // A second tick lands while the first /compact call is still in flight.
    const secondTick = checkContextCompaction({ dir: CLAUDE_DIR, getEngine: () => engine }, inFlight);
    expect(secondTick).toHaveLength(0);

    resolveRun({ result: "", sessionId: "native-sess-1" });
    await Promise.all(firstTick);
  });

  it("skips a session whose engine isn't resolvable, without throwing", async () => {
    const session = makeIdleSession();
    writeSnapshot(session.id, 90);

    const pending = checkContextCompaction({ dir: CLAUDE_DIR, getEngine: () => undefined });
    expect(pending).toHaveLength(0);
  });
});
