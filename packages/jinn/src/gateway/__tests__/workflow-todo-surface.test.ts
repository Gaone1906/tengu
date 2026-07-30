import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// Point the registry DB at a throwaway home BEFORE importing anything that
// resolves SESSIONS_DB at module load. Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wf-todo-surface-"));
process.env.JINN_HOME = tmp;

type Surface = typeof import("../workflow-todo-surface.js");
type Store = typeof import("../../work-items/store.js");
type Transitions = typeof import("../../work-items/transitions.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Comments = typeof import("../../work-items/comments.js");
type Reconcile = typeof import("../../work-items/reconcile.js");

let surface: Surface;
let store: Store;
let transitions: Transitions;
let approvals: Approvals;
let comments: Comments;
let reconcile: Reconcile;

type Source = NonNullable<Parameters<Store["createWorkItem"]>[0]["source"]>;

/** A Todo bound to a run, in the status the run's trigger leaves it in. */
function armedTodo(title: string, source: Source = "human"): string {
  return store.createWorkItem({ title, source, status: "assigned" }).id;
}

function reflect(todoId: string, status: "executing" | "in_review" | "blocked", nodeId = "plan"): void {
  surface.workflowTodoLifecycle.reflect({ todoId, status, workflowId: "pipeline", runId: "run_1", nodeId });
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  transitions = await import("../../work-items/transitions.js");
  approvals = await import("../../work-items/approvals.js");
  comments = await import("../../work-items/comments.js");
  reconcile = await import("../../work-items/reconcile.js");
  surface = await import("../workflow-todo-surface.js");
});

beforeEach(() => {
  transitions.setTodoStatusChangeListener(null);
  approvals.setTodoApprovalDecisionListener(null);
});

describe("reflecting a run's lifecycle onto its bound Todo", () => {
  it("moves an armed Todo to executing and marks the write DERIVED, not declared", () => {
    const id = armedTodo("first phase dispatches");
    reflect(id, "executing");

    expect(store.getWorkItem(id)!.status).toBe("executing");
    // Derived, so the reconciler's provenance checks stay able to re-derive it.
    expect(store.isBlockDeclared(id)).toBe(false);
  });

  it("yields to a block a phase declared with a reason", () => {
    const id = armedTodo("phase blocked it with a reason");
    transitions.transition(id, "blocked", "session:abc", { agent: true, detail: { reason: "no upstream data" } });
    expect(store.isBlockDeclared(id)).toBe(true);

    reflect(id, "executing");
    reflect(id, "in_review", "gate");

    expect(store.getWorkItem(id)!.status).toBe("blocked");
  });

  it("does not restart a Todo a phase has already moved past assigned", () => {
    const id = armedTodo("phase already put it in review");
    transitions.transition(id, "in_review", "session:abc", { agent: true });

    reflect(id, "executing");

    expect(store.getWorkItem(id)!.status).toBe("in_review");
  });

  it("still parks a Todo whose block was DERIVED rather than declared", () => {
    const id = armedTodo("earlier run reflected a block");
    reflect(id, "executing");
    reflect(id, "blocked", "plan");
    expect(store.isBlockDeclared(id)).toBe(false);

    reflect(id, "in_review", "gate");

    expect(store.getWorkItem(id)!.status).toBe("in_review");
  });

  it("still reports a dead run, because a failed run is the newest fact about the work", () => {
    const id = armedTodo("phase reviewed it, then the run died");
    transitions.transition(id, "in_review", "session:abc", { agent: true });

    reflect(id, "blocked", "land");

    expect(store.getWorkItem(id)!.status).toBe("blocked");
  });

  it("never pulls a Todo out of a sticky terminal", () => {
    const escalated = armedTodo("escalated to the operator");
    transitions.transition(escalated, "escalated", "session:abc", { agent: true });
    reflect(escalated, "executing");
    reflect(escalated, "blocked");
    expect(store.getWorkItem(escalated)!.status).toBe("escalated");

    const done = armedTodo("already closed");
    transitions.transition(done, "done", "reviewer");
    reflect(done, "blocked");
    expect(store.getWorkItem(done)!.status).toBe("done");
  });

  it("records which node died, the error, and the run id — no LLM call", () => {
    const id = armedTodo("run failed at land");
    surface.workflowTodoLifecycle.recordFailure({
      todoId: id, workflowId: "jinn-build", runId: "run_abc", nodeId: "land",
      error: { code: "workflow-step-failed", message: "Interactive turn failed: invalid_request", retryable: false },
    });

    const body = comments.commentsTail(id).comments[0]!.body;
    expect(body).toContain("jinn-build");
    expect(body).toContain("run_abc");
    expect(body).toContain("land");
    expect(body).toContain("Interactive turn failed: invalid_request");
  });

  it("survives a Todo that no longer exists", () => {
    expect(() => reflect("JIN-99999", "blocked")).not.toThrow();
  });
});

describe("a parked gate must not be mistaken for a finished review", () => {
  it("does not TRUST-close a trust-tier Todo while its approval is still pending", () => {
    // `cron` provenance defaults to trust, so this item auto-closes from in_review.
    const id = armedTodo("trust-tier Todo parked on a merge gate", "cron");
    expect(store.effectiveVerifyMode(store.getWorkItem(id)!)).toBe("trust");
    approvals.requestApproval(id, {
      request: "Approving merges this branch into main.",
      ref: "workflow:jinn-build:run_abc:land-approval",
      actor: "workflow",
    });
    reflect(id, "in_review", "land-approval");

    reconcile.reconcileWorkItem(id);
    reconcile.reconcileActiveWorkItems();

    expect(store.getWorkItem(id)!.status).toBe("in_review");
  });

  it("TRUST-closes once the gate is decided", async () => {
    const id = armedTodo("trust-tier Todo with a native review gate", "cron");
    approvals.requestApproval(id, { request: "Ship it?", actor: "reviewer" });
    reflect(id, "in_review", "gate");
    await approvals.decideWorkItemApproval({ id, decision: "approve", decidedBy: "operator" });

    expect(store.getWorkItem(id)!.status).toBe("done");
  });

  it("does not close a Todo when the decided gate belongs to a run mid-pipeline", async () => {
    const id = armedTodo("run parked on its variant pick");
    reflect(id, "executing");
    approvals.requestApproval(id, {
      request: "Pick a variant to continue.",
      ref: "workflow:jinn-build:run_abc:pick",
      options: ["Variant A", "Variant B"],
      actor: "workflow",
    });
    reflect(id, "in_review", "pick");

    const decided = await approvals.decideWorkItemApproval({
      id, decision: "approve", choice: "Variant A", decidedBy: "operator",
    });

    expect(decided.ok).toBe(true);
    // The decision is recorded — the run reads the pick and carries on — but the
    // Todo is NOT closed: IMPLEMENT and VERIFY have not run yet.
    expect(store.getWorkItem(id)!.status).toBe("in_review");
    expect(approvals.currentApproval(id)).toMatchObject({ state: "approved", choice: "Variant A" });
  });

  it("still applies the native consequence to a gate nobody mirrored", async () => {
    const id = armedTodo("native review gate");
    transitions.transition(id, "in_review", "session:abc", { agent: true });
    approvals.requestApproval(id, { request: "Approve this work?", actor: "reviewer" });

    await approvals.decideWorkItemApproval({ id, decision: "approve", decidedBy: "operator" });

    expect(store.getWorkItem(id)!.status).toBe("done");
  });
});
