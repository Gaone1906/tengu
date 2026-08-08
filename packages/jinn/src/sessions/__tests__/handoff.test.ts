import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Engine } from "../../shared/types.js";
import type { GovernorDecision } from "../../shared/governor.js";

/**
 * Halt/handoff/auto-resume (docs/tengu/03-implementation-plan.md step 6,
 * docs/tengu/10-checkpointing.md). Every `resumeAt` here is stubbed a couple
 * of minutes out — never a real 5-hour wait — proving: the handoff file is
 * written, the work item records its path, and a correctly-shaped one-shot
 * resume job is scheduled.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-handoff-"));
process.env.JINN_HOME = tmp;

type Handoff = typeof import("../handoff.js");
type Store = typeof import("../../work-items/store.js");
type Comments = typeof import("../../work-items/comments.js");
type Registry = typeof import("../registry.js");
type Jobs = typeof import("../../cron/jobs.js");
type Paths = typeof import("../../shared/paths.js");

let handoff: Handoff;
let store: Store;
let comments: Comments;
let registry: Registry;
let jobs: Jobs;
let paths: Paths;

beforeAll(async () => {
  [handoff, store, comments, registry, jobs, paths] = await Promise.all([
    import("../handoff.js"),
    import("../../work-items/store.js"),
    import("../../work-items/comments.js"),
    import("../registry.js"),
    import("../../cron/jobs.js"),
    import("../../shared/paths.js"),
  ]);
  (await import("../../shared/db.js")).initDb();
});

function nearFutureIso(minutesOut = 2): string {
  return new Date(Date.now() + minutesOut * 60_000).toISOString();
}

describe("writeHandoffFile", () => {
  it("writes ONLY in-flight state to ~/.{instance}/handoffs/<employee>-<todoId>.md", () => {
    const filePath = handoff.writeHandoffFile({
      employee: "engineer",
      todoId: "JIN-42.3",
      sessionId: "sess-1",
      interruptedUnit: "Add residency_status to the address payload",
      attempted: "Wrote the schema field; test was mid-run when halted.",
      wipRef: "refs/jinn/wip/sess-1",
      surprises: "The address schema is generated, not hand-written.",
    });

    expect(filePath).toBe(path.join(paths.HANDOFFS_DIR, "engineer-JIN-42.3.md"));
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("Add residency_status to the address payload");
    expect(content).toContain("Wrote the schema field; test was mid-run when halted.");
    expect(content).toContain("refs/jinn/wip/sess-1");
    expect(content).toContain("The address schema is generated, not hand-written.");
    expect(content).toContain("sess-1");
  });

  it("stays small — no attempt to restate what the ledger already records as done", () => {
    const filePath = handoff.writeHandoffFile({
      employee: "engineer",
      todoId: "JIN-1.1",
      sessionId: "sess-2",
      interruptedUnit: "Unit X",
      attempted: "Tried Y.",
    });
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content.length).toBeLessThan(1000);
  });
});

describe("recordHandoffOnWorkItem", () => {
  it("adds a comment on the work item recording the handoff's path", () => {
    const item = store.createWorkItem({ title: "checkpointed unit" });
    const filePath = handoff.handoffPathFor("engineer", item.id);

    handoff.recordHandoffOnWorkItem(item.id, filePath);

    const page = comments.listComments(item.id);
    expect(page.comments.some((c) => c.authorKind === "system" && c.body.includes(filePath))).toBe(true);
  });
});

describe("scheduleGovernorResume", () => {
  it("persists a one-shot 'runAt' job at resumeAt + 60s, keyed to resume the SAME session", () => {
    const session = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:handoff-schedule",
      model: "sonnet",
    });
    const resumeAt = nearFutureIso(2);

    const job = handoff.scheduleGovernorResume({
      session,
      employee: "engineer",
      todoId: "JIN-9.1",
      resumeAt,
    });

    expect(job.kind).toBe("runAt");
    expect(job.enabled).toBe(true);
    expect(job.resumeSessionKey).toBe(session.sessionKey);
    expect(new Date(job.runAt!).getTime()).toBe(new Date(resumeAt).getTime() + 60_000);

    const persisted = jobs.loadJobs().find((j) => j.id === job.id);
    expect(persisted).toBeDefined();
    expect(persisted?.resumeSessionKey).toBe(session.sessionKey);
  });
});

describe("performGovernorHalt", () => {
  it("writes the handoff, records it on the work item, compacts in place, and schedules the resume — all from one near-future decision", async () => {
    const item = store.createWorkItem({ title: "JIN-7.2 checkpoint unit" });
    const session = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:governor-halt",
      model: "sonnet",
    });
    store.linkSession(item.id, session.id);
    registry.updateSession(session.id, { engineSessionId: "native-sess-1" });
    const liveSession = registry.getSession(session.id)!;

    const compactCalls: Array<{ prompt: string; resumeSessionId?: string }> = [];
    const engine: Engine = {
      name: "claude",
      run: async (opts) => {
        compactCalls.push({ prompt: opts.prompt, resumeSessionId: opts.resumeSessionId });
        return { result: "compacted", sessionId: opts.resumeSessionId ?? "" };
      },
    };

    const decision: GovernorDecision = {
      action: "halt",
      reason: "5-hour usage at 95% has reached the 80% stop threshold",
      resumeAt: nearFutureIso(2),
    };

    const result = await handoff.performGovernorHalt({
      session: liveSession,
      employee: "engineer",
      engine,
      decision,
    });

    // 1. Handoff file written.
    expect(fs.existsSync(result.handoffPath)).toBe(true);
    expect(result.handoffPath).toBe(path.join(paths.HANDOFFS_DIR, `engineer-${item.id}.md`));

    // 2. Work item records the handoff's path.
    const page = comments.listComments(item.id);
    expect(page.comments.some((c) => c.body.includes(result.handoffPath))).toBe(true);

    // 3. One-shot job scheduled correctly (resumeAt + 60s, resumes THIS session).
    expect(result.job.kind).toBe("runAt");
    expect(result.job.resumeSessionKey).toBe(session.sessionKey);
    expect(new Date(result.job.runAt!).getTime()).toBe(new Date(decision.resumeAt!).getTime() + 60_000);
    const persistedJob = jobs.loadJobs().find((j) => j.id === result.job.id);
    expect(persistedJob?.enabled).toBe(true);

    // 4. /compact ran in place on the SAME engine session before the halt.
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.prompt).toBe("/compact");
    expect(compactCalls[0]?.resumeSessionId).toBe("native-sess-1");
  });

  it("throws (rather than scheduling an un-resumable resume) when the governor decision has no resumeAt", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:no-resume-at", model: "sonnet" });
    const engine: Engine = { name: "claude", run: async () => ({ result: "", sessionId: "" }) };
    await expect(handoff.performGovernorHalt({
      session,
      employee: "engineer",
      engine,
      decision: { action: "halt", reason: "no resumeAt available" },
    })).rejects.toThrow(/resumeAt/);
  });
});
