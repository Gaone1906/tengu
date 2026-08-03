import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB (SESSIONS_DB resolves from JINN_HOME at module load) —
// keep the suite off the live DB. Set BEFORE importing the store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wf-todo-revise-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Comments = typeof import("../../work-items/comments.js");
type Surface = typeof import("../workflow-todo-surface.js");
type Transitions = typeof import("../../work-items/transitions.js");
let store: Store;
let approvals: Approvals;
let comments: Comments;
let surface: Surface;
let transitions: Transitions;

/* Where a rejection-with-feedback actually lands the Todo: the re-arm, the bound on
 * how many times it may go round, and every path that refuses to re-arm — because a
 * Todo parked at a status whose trigger fires nothing looks queued forever, which is
 * the single worst outcome of a feedback loop. */

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  comments = await import("../../work-items/comments.js");
  surface = await import("../workflow-todo-surface.js");
  transitions = await import("../../work-items/transitions.js");
  dbModule.initDb();
});

let seq = 0;

/** A Todo parked in review on a mirrored gate, exactly as a run leaves it. */
function parkedOnGate(opts: { runId?: string; note?: string | null } = {}) {
  seq += 1;
  const runId = opts.runId ?? `run_${seq}`;
  const item = store.createWorkItem({ title: `Build ${seq}`, status: "in_review", source: "human" });
  approvals.requestApproval(item.id, {
    request: "Approving merges this branch into main.",
    ref: `workflow:build:${runId}:land-approval`,
  });
  return { item, runId };
}

/** Record a rejection on the parked gate, as the Todo decision path does before
 *  the run is told — the note it writes is what the cycle count reads. */
async function rejectGate(id: string, note: string, decidedBy = "operator") {
  const result = await approvals.decideWorkItemApproval({ id, decision: "reject", note, decidedBy });
  expect(result.ok).toBe(true);
}

function request(item: { id: string }, runId: string, feedback: string,
  rearm: Parameters<Surface["workflowTodoLifecycle"]["requestRevision"]>[0]["rearm"],
  decidedBy = "operator") {
  surface.workflowTodoLifecycle.requestRevision({
    todoId: item.id, workflowId: "build", runId, nodeId: "land-approval", feedback, decidedBy, rearm,
  });
}

function bodies(id: string): string[] {
  return comments.listComments(id).comments.map((comment) => comment.body);
}

beforeEach(() => { /* each case mints its own Todo; nothing shared to reset */ });

describe("a rejection with feedback puts the Todo back where its trigger fires", () => {
  it("re-arms to the trigger's status, recorded as the rejecter's own move", async () => {
    const { item, runId } = parkedOnGate();
    await rejectGate(item.id, "The empty state still reads as an error.");

    request(item, runId, "The empty state still reads as an error.", { status: "assigned", actor: "operator" });

    const updated = store.getWorkItem(item.id)!;
    expect(updated.status).toBe("assigned");
    // `in_review → assigned` is deliberately NOT a legal drag on the board, so the
    // re-arm has to be its own lane — otherwise this is where the loop dies.
    const move = store.listWorkItemEvents(item.id).filter((event) => event.kind === "status_change").at(-1)!;
    expect(move).toMatchObject({ fromStatus: "in_review", toStatus: "assigned", actor: "operator" });
    expect(move.detail).toMatchObject({ revision: 1, feedback: "The empty state still reads as an error." });
  });

  it("writes the feedback as a comment the next run reads, quoted verbatim", async () => {
    const { item, runId } = parkedOnGate();
    const feedback = "have the screenshot attachments a bit more UI friendly\nnot title + size, only on hover";
    await rejectGate(item.id, feedback);

    request(item, runId, feedback, { status: "assigned" });

    const comment = bodies(item.id).at(-1)!;
    expect(comment).toContain("Sent back for revision");
    expect(comment).toContain("round 1 of 3");
    expect(comment).toContain("> have the screenshot attachments a bit more UI friendly");
    expect(comment).toContain("> not title + size, only on hover");
    expect(comment).toContain("this wins");
  });

  it("escalates instead of re-arming once the loop has been round its cap", async () => {
    const { item } = parkedOnGate();
    // Three rejections, three re-arms — each needs its own fresh human rejection,
    // so the loop cannot spin; the bound is about a Todo that is not converging.
    for (let cycle = 1; cycle <= surface.MAX_REVISION_CYCLES; cycle += 1) {
      const runId = `run_cycle_${cycle}`;
      approvals.requestApproval(item.id, { request: "Merge?", ref: `workflow:build:${runId}:land-approval` });
      await rejectGate(item.id, `Round ${cycle} feedback.`);
      request(item, runId, `Round ${cycle} feedback.`, { status: "assigned" });
      expect(store.getWorkItem(item.id)!.status).toBe("assigned");
    }

    const runId = "run_cycle_over";
    approvals.requestApproval(item.id, { request: "Merge?", ref: `workflow:build:${runId}:land-approval` });
    await rejectGate(item.id, "Still not right.");
    request(item, runId, "Still not right.", { status: "assigned" });

    expect(store.getWorkItem(item.id)!.status).toBe("escalated");
    const comment = bodies(item.id).at(-1)!;
    expect(comment).toContain(`already been sent back ${surface.MAX_REVISION_CYCLES} times`);
    expect(comment).toContain("needs a conversation, not another run");
  });

  it("counts only run-bound rejections that carried feedback", async () => {
    const { item, runId } = parkedOnGate();
    // A silent rejection is a stop, not a cycle; a native (non-mirrored) review
    // bounce is a different event and must not spend this budget.
    approvals.requestApproval(item.id, { request: "Merge?", ref: `workflow:build:${runId}:land-approval` });
    await rejectGate(item.id, "");
    approvals.requestApproval(item.id, { request: "Native review", ref: null });
    await rejectGate(item.id, "Reviewer critique, not a workflow gate.");

    approvals.requestApproval(item.id, { request: "Merge?", ref: `workflow:build:${runId}:land-approval` });
    await rejectGate(item.id, "First real revision.");
    request(item, runId, "First real revision.", { status: "assigned" });

    expect(bodies(item.id).at(-1)!).toContain("round 1 of 3");
  });

  it("says a non-operator actor filter would suppress the re-arm, and blocks instead", async () => {
    const { item, runId } = parkedOnGate();
    await rejectGate(item.id, "Wrong shade of blue.");

    request(item, runId, "Wrong shade of blue.", { status: "assigned", actor: "reconciler" });

    expect(store.getWorkItem(item.id)!.status).toBe("blocked");
    expect(store.isBlockDeclared(item.id)).toBe(true);
    const comment = bodies(item.id).at(-1)!;
    expect(comment).toContain("only fires for actor `reconciler`");
    expect(comment).toContain("`operator` rejected this");
    expect(comment).toContain("> Wrong shade of blue.");
  });

  it("blocks with the reason when the workflow can no longer run", async () => {
    const { item, runId } = parkedOnGate();
    await rejectGate(item.id, "Needs a second pass.");

    request(item, runId, "Needs a second pass.", { unavailable: "workflow `build` is disabled" });

    expect(store.getWorkItem(item.id)!.status).toBe("blocked");
    expect(bodies(item.id).at(-1)!).toContain("it cannot run again: workflow `build` is disabled");
  });

  it("blocks with the reason when the Todo refuses the re-arm", async () => {
    const { item, runId } = parkedOnGate();
    await rejectGate(item.id, "One more go.");
    // A sticky terminal cannot be left without human authority, and a re-arm that
    // silently did nothing would be indistinguishable from a queued Todo.
    transitions.transition(item.id, "cancelled", "operator", { human: true });

    request(item, runId, "One more go.", { status: "assigned" });

    expect(store.getWorkItem(item.id)!.status).toBe("cancelled");
    expect(bodies(item.id).at(-1)!).toContain("it could not be moved to `assigned`");
  });
});
