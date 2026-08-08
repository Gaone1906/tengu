import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Engine, EngineResult } from "../../shared/types.js";
import type { GovernorDecision } from "../../shared/governor.js";

/**
 * Context compaction (docs/tengu/03-implementation-plan.md step 7, D5). At
 * 80% context usage the session must compact IN PLACE and stay warm — no
 * halt, no status change, no resume job — and re-inject its handoff note
 * only once Claude Code's own SessionStart(source:"compact") confirms the
 * compaction actually replaced the conversation.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-compaction-"));
process.env.JINN_HOME = tmp;

type Compaction = typeof import("../compaction.js");
type Handoff = typeof import("../handoff.js");
type Governor = typeof import("../../shared/governor.js");
type Registry = typeof import("../registry.js");

let compaction: Compaction;
let handoff: Handoff;
let governor: Governor;
let registry: Registry;

beforeAll(async () => {
  [compaction, handoff, governor, registry] = await Promise.all([
    import("../compaction.js"),
    import("../handoff.js"),
    import("../../shared/governor.js"),
    import("../registry.js"),
  ]);
});

function fakeEngine(runImpl: (opts: { prompt: string; resumeSessionId?: string }) => EngineResult): { engine: Engine; calls: Array<{ prompt: string; resumeSessionId?: string }> } {
  const calls: Array<{ prompt: string; resumeSessionId?: string }> = [];
  const engine: Engine = {
    name: "claude",
    run: async (opts) => {
      calls.push({ prompt: opts.prompt, resumeSessionId: opts.resumeSessionId });
      return runImpl(opts);
    },
  };
  return { engine, calls };
}

describe("evaluateGovernor — the explicit 80%-context trigger", () => {
  it("fires a \"handoff\" decision at exactly 80% context usage, not below", () => {
    expect(governor.evaluateGovernor({ contextUsedPct: 79 }, undefined).action).toBe("run");
    expect(governor.evaluateGovernor({ contextUsedPct: 80 }, undefined).action).toBe("handoff");
    expect(governor.evaluateGovernor({ contextUsedPct: 95 }, undefined).action).toBe("handoff");
  });

  it("never returns \"halt\" for context pressure alone (D5: only usage halts)", () => {
    const decision = governor.evaluateGovernor({ contextUsedPct: 99 }, undefined);
    expect(decision.action).not.toBe("halt");
    expect(decision.resumeAt).toBeUndefined();
  });
});

describe("performInPlaceCompaction", () => {
  function makeSession() {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:compaction-test-${Date.now()}-${Math.random()}`, model: "sonnet" });
    registry.updateSession(session.id, { engineSessionId: "native-sess-compact" });
    return registry.getSession(session.id)!;
  }

  const handoffDecision: GovernorDecision = { action: "handoff", reason: "context usage at 85% has reached the 80% compaction threshold" };

  it("sends /compact on the SAME engine session id, in place, without touching status or scheduling a resume", async () => {
    const session = makeSession();
    const { engine, calls } = fakeEngine(() => ({ result: "compacted", sessionId: "native-sess-compact" }));

    const result = await compaction.performInPlaceCompaction({
      session, employee: "engineer", engine, decision: handoffDecision,
    });

    expect(result.compacted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("/compact");
    expect(calls[0]?.resumeSessionId).toBe("native-sess-compact");

    const after = registry.getSession(session.id)!;
    expect(after.status).toBe(session.status); // untouched — D5: compact in place, never halt
  });

  it("does nothing for a \"run\" decision — context under threshold", async () => {
    const session = makeSession();
    const { engine, calls } = fakeEngine(() => ({ result: "", sessionId: "native-sess-compact" }));

    const result = await compaction.performInPlaceCompaction({
      session, employee: "engineer", engine, decision: { action: "run", reason: "usage within thresholds" },
    });

    expect(result).toEqual({ compacted: false, handoffReinjected: false });
    expect(calls).toHaveLength(0);
  });

  it("does nothing for a \"halt\" decision — that's sessions/handoff.ts's job, not this one", async () => {
    const session = makeSession();
    const { engine, calls } = fakeEngine(() => ({ result: "", sessionId: "native-sess-compact" }));

    const result = await compaction.performInPlaceCompaction({
      session, employee: "engineer", engine,
      decision: { action: "halt", reason: "5-hour usage at 95% has reached the 80% stop threshold", resumeAt: new Date().toISOString() },
    });

    expect(result).toEqual({ compacted: false, handoffReinjected: false });
    expect(calls).toHaveLength(0);
  });

  it("skips compaction when the session has no engine session id yet", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:no-engine-session", model: "sonnet" });
    const { engine, calls } = fakeEngine(() => ({ result: "", sessionId: "" }));

    const result = await compaction.performInPlaceCompaction({
      session, employee: "engineer", engine, decision: handoffDecision,
    });

    expect(result).toEqual({ compacted: false, handoffReinjected: false });
    expect(calls).toHaveLength(0);
  });

  it("re-injects the handoff note as a follow-up turn when SessionStart fires with source:\"compact\"", async () => {
    const session = makeSession();
    // No linked work item — performInPlaceCompaction falls back todoId to session.id.
    const handoffPath = handoff.writeHandoffFile({
      employee: "engineer",
      todoId: session.id,
      sessionId: session.id,
      interruptedUnit: "Add residency_status to the address payload",
      attempted: "Wrote the schema field; test was mid-run when context hit 80%.",
    });
    expect(fs.existsSync(handoffPath)).toBe(true);

    const { engine, calls } = fakeEngine((opts) =>
      opts.prompt === "/compact"
        ? { result: "", sessionId: "native-sess-compact", sessionStartSource: "compact" }
        : { result: "", sessionId: "native-sess-compact" },
    );

    const result = await compaction.performInPlaceCompaction({
      session, employee: "engineer", engine, decision: handoffDecision,
    });

    expect(result).toEqual({ compacted: true, handoffReinjected: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("/compact");
    expect(calls[1]?.prompt).toContain("Add residency_status to the address payload");
    expect(calls[1]?.prompt).toContain("Wrote the schema field; test was mid-run when context hit 80%.");
    expect(calls[1]?.resumeSessionId).toBe("native-sess-compact");
  });

  it("does NOT re-inject when the engine never confirms source:\"compact\" (compaction may not actually have run)", async () => {
    const session = makeSession();
    handoff.writeHandoffFile({
      employee: "engineer",
      todoId: session.id,
      sessionId: session.id,
      interruptedUnit: "Some other unit",
      attempted: "Some other attempt.",
    });

    const { engine, calls } = fakeEngine(() => ({ result: "", sessionId: "native-sess-compact" })); // no sessionStartSource

    const result = await compaction.performInPlaceCompaction({
      session, employee: "engineer", engine, decision: handoffDecision,
    });

    expect(result).toEqual({ compacted: true, handoffReinjected: false });
    expect(calls).toHaveLength(1); // only the /compact call — no follow-up
  });

  it("does NOT re-inject when source is \"compact\" but no handoff file exists for this employee/todo", async () => {
    const session = makeSession();
    const { engine, calls } = fakeEngine((opts) =>
      opts.prompt === "/compact"
        ? { result: "", sessionId: "native-sess-compact", sessionStartSource: "compact" }
        : { result: "", sessionId: "native-sess-compact" },
    );

    const result = await compaction.performInPlaceCompaction({
      session, employee: "nobody-with-a-handoff", engine, decision: handoffDecision,
    });

    expect(result).toEqual({ compacted: true, handoffReinjected: false });
    expect(calls).toHaveLength(1);
  });
});
