import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB (SESSIONS_DB resolves from JINN_HOME at module load) —
// keep the suite off the live DB. Set BEFORE importing the store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-appr-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Approvals = typeof import("../approvals.js");
type Reg = typeof import("../../sessions/registry.js");
type ApprovalAuthority = typeof import("../../gateway/approval-authority.js");
let store: Store;
let approvals: Approvals;
let reg: Reg;
let approvalAuthority: ApprovalAuthority;

beforeAll(async () => {
  store = await import("../store.js");
  approvals = await import("../approvals.js");
  reg = await import("../../sessions/registry.js");
  approvalAuthority = await import("../../gateway/approval-authority.js");
  reg.initDb();
});

function kinds(id: string): string[] {
  return store.listWorkItemEvents(id).map((e) => e.kind);
}

/* ── requestApproval — the native "any actor may REQUEST" write path (§1.3) ──── */

describe("requestApproval — the native approval-request write path", () => {
  it("sets pending + request text and appends exactly one approval_requested event", () => {
    const item = store.createWorkItem({ title: "Ship the thing", status: "in_review", source: "delegation" });
    const out = approvals.requestApproval(item.id, { request: "Approve the deployment?" });
    expect(out.approvalState).toBe("pending");
    expect(out.approvalRequest).toBe("Approve the deployment?");
    expect(out.approvalRef).toBeNull();
    // status is orthogonal — untouched by a request
    expect(out.status).toBe("in_review");
    const evts = store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_requested");
    expect(evts.length).toBe(1);
    expect(evts[0].detail).toMatchObject({ request: "Approve the deployment?" });
  });

  it("carries a mirror ref when provided (workflow-gate mirror)", () => {
    const item = store.createWorkItem({ title: "Run gate", status: "executing", source: "workflow" });
    const ref = "workflow-gate:def-a:run_1:gate-1";
    const out = approvals.requestApproval(item.id, { request: "Publish the report", ref, target: "coo" });
    expect(out.approvalState).toBe("pending");
    expect(out.approvalRef).toBe(ref);
    expect(out.approvalTarget).toBe("coo");
    expect(store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_requested").length).toBe(1);
  });

  it("persists the routed approval target and clears escalation on a new request", () => {
    const item = store.createWorkItem({ title: "Targeted approval", status: "assigned", source: "delegation" });
    const out = approvals.requestApproval(item.id, { request: "Manager sign-off", target: "platform-manager", actor: "session:s1" });
    expect(out.approvalState).toBe("pending");
    expect(out.approvalTarget).toBe("platform-manager");
    expect(out.approvalEscalatedAt).toBeNull();
    const event = store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_requested").at(-1)!;
    expect(event.detail).toMatchObject({ request: "Manager sign-off", target: "platform-manager" });

    const escalated = approvals.escalateApproval(item.id, "coo");
    expect(escalated.approvalEscalatedAt).toBeTruthy();

    const rerouted = approvals.requestApproval(item.id, { request: "Fresh manager sign-off", target: "platform-manager" });
    expect(rerouted.approvalTarget).toBe("platform-manager");
    expect(rerouted.approvalEscalatedAt).toBeNull();
  });

  it("is idempotent when already pending on the SAME ref — no duplicate event", () => {
    const item = store.createWorkItem({ title: "Idem", status: "executing", source: "workflow" });
    const ref = "workflow-gate:def-b:run_2:gate";
    approvals.requestApproval(item.id, { request: "gate", ref });
    approvals.requestApproval(item.id, { request: "gate", ref });
    expect(store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_requested").length).toBe(1);
  });

  it("throws on an unknown item", () => {
    expect(() => approvals.requestApproval("wi_missing", { request: "x" })).toThrow();
  });

  it("persists explicit target:null as no target across a round trip", () => {
    const item = store.createWorkItem({ title: "No routed approver", status: "backlog", source: "human" });
    const out = approvals.requestApproval(item.id, { request: "record only", target: null });

    expect(out.approvalTarget).toBeNull();
    expect(out.approvalTargetKind).toBe("none");

    const roundTrip = store.getWorkItem(item.id)!;
    expect(roundTrip.approvalTarget).toBeNull();
    expect(roundTrip.approvalTargetKind).toBe("none");
    expect(approvalAuthority.resolveApprovalRouteTarget(roundTrip).target).toBeNull();
  });
});

/* ── raw decision door closure ───────────────────────────────────────────────── */

describe("raw approval decision door", () => {
  it("does not export the low-level decideApproval writer", () => {
    expect("decideApproval" in approvals).toBe(false);
  });

  it("exposes only a mirror-clear wrapper, and refuses native approvals", () => {
    const item = store.createWorkItem({ title: "Native approval", status: "in_review", source: "human" });
    approvals.requestApproval(item.id, { request: "ok?" });
    expect(() => approvals.recordMirroredApprovalDecision(item.id, "approve", "coo")).toThrow(/not a workflow-gate mirror/i);
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
    expect(store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_decided")).toHaveLength(0);
  });

  it("mirror clear → decided stamps + one approval_decided event with the actor", () => {
    const item = store.createWorkItem({ title: "Mirror approval", status: "executing", source: "workflow" });
    approvals.requestApproval(item.id, {
      request: "ok?",
      ref: "workflow-gate:def-a:run-1:gate",
      target: "coo",
    });
    const out = approvals.recordMirroredApprovalDecision(item.id, "approve", "coo");
    expect(out.approvalState).toBe("approved");
    expect(out.approvalDecidedBy).toBe("coo");
    expect(out.approvalDecidedAt).toBeTruthy();
    const evts = store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_decided");
    expect(evts.length).toBe(1);
    expect(evts[0].detail).toMatchObject({ decision: "approve", ref: "workflow-gate:def-a:run-1:gate" });
  });

  it("mirror clear throws instead of writing when no pending approval exists", () => {
    const item = store.createWorkItem({ title: "No raw double decide", status: "executing", source: "workflow" });
    approvals.requestApproval(item.id, { request: "ok?", ref: "workflow-gate:def-a:run-2:gate" });
    approvals.recordMirroredApprovalDecision(item.id, "approve", "coo");
    expect(() => approvals.recordMirroredApprovalDecision(item.id, "reject", "coo")).toThrow(/no pending approval/i);
    expect(store.getWorkItem(item.id)!.approvalState).toBe("approved");
    expect(store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_decided")).toHaveLength(1);
  });
});

/* ── decideWorkItemApproval — the fixed consequence rules (§1.3, item 3) ───────── */

describe("decideWorkItemApproval — native consequence rules", () => {
  it("not-found for an unknown item", async () => {
    const r = await approvals.decideWorkItemApproval({ id: "wi_none", decision: "approve" }, {});
    expect(r).toMatchObject({ ok: false, code: "not-found" });
  });

  it("no-pending when the item has no pending approval", async () => {
    const item = store.createWorkItem({ title: "No approval", status: "in_review", source: "human" });
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve" }, {});
    expect(r).toMatchObject({ ok: false, code: "no-pending" });
  });

  it("APPROVE + in_review → done (approval_decided THEN status_change), not mirrored", async () => {
    const item = store.createWorkItem({ title: "Approve to done", status: "in_review", source: "human" });
    approvals.requestApproval(item.id, { request: "close it?" });
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", note: "ship" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mirrored).toBe(false);
    expect(r.escalated).toBe(false);
    expect(r.item.status).toBe("done");
    expect(r.item.approvalState).toBe("approved");
    expect(r.item.closedAt).toBeTruthy();
    // ordered audit: request → decided → status_change(done)
    const k = kinds(item.id);
    expect(k.slice(-3)).toEqual(["approval_requested", "approval_decided", "status_change"]);
    const sc = store.listWorkItemEvents(item.id).filter((e) => e.kind === "status_change").at(-1)!;
    expect(sc.toStatus).toBe("done");
  });

  it("APPROVE + backlog (non-in_review) → decision recorded, status UNTOUCHED (no status_change)", async () => {
    const item = store.createWorkItem({ title: "Plan approval on backlog", status: "backlog", source: "human" });
    approvals.requestApproval(item.id, { request: "proceed with the plan?" });
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.status).toBe("backlog");
    expect(r.item.approvalState).toBe("approved");
    // the ONLY event past the request is the decision — no status_change
    expect(store.listWorkItemEvents(item.id).some((e) => e.kind === "status_change")).toBe(false);
  });

  it("REJECT + in_review → bounce to executing, rounds++, critique on the status_change", async () => {
    const item = store.createWorkItem({ title: "Send back", status: "in_review", source: "human" });
    approvals.requestApproval(item.id, { request: "good?" });
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "fix the tests" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.status).toBe("executing");
    expect(r.item.rounds).toBe(1);
    expect(r.escalated).toBe(false);
    const sc = store.listWorkItemEvents(item.id).filter((e) => e.kind === "status_change").at(-1)!;
    expect(sc.toStatus).toBe("executing");
    expect(sc.detail).toMatchObject({ bounce: true, critique: "fix the tests" });
  });

  it("REJECT + in_review at max rounds → escalated INSTEAD of executing", async () => {
    // maxRounds:1 → the first reject bounce exhausts it and escalates.
    const item = store.createWorkItem({
      title: "Escalate on max rounds",
      status: "in_review",
      source: "human",
      verifyPolicy: { mode: "verify", maxRounds: 1 },
    });
    approvals.requestApproval(item.id, { request: "good?" });
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "still wrong" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.status).toBe("escalated");
    expect(r.escalated).toBe(true);
    expect(r.item.rounds).toBe(1);
    const evt = store.listWorkItemEvents(item.id).filter((e) => e.kind === "escalated").at(-1)!;
    expect(evt.toStatus).toBe("escalated");
  });

  it("REJECT + backlog → decision recorded, status UNTOUCHED", async () => {
    const item = store.createWorkItem({ title: "Reject a plan", status: "backlog", source: "human" });
    approvals.requestApproval(item.id, { request: "plan ok?" });
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "rethink" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.status).toBe("backlog");
    expect(r.item.approvalState).toBe("rejected");
    expect(store.listWorkItemEvents(item.id).some((e) => e.kind === "status_change")).toBe(false);
  });
});

/* ── decideWorkItemApproval — mirrored (workflow-park) routing (§1.3, item 4) ──── */

describe("decideWorkItemApproval — mirrored workflow-park routing", () => {
  function mirrored(refGate: string) {
    const item = store.createWorkItem({ title: "Parked run", status: "executing", source: "workflow" });
    approvals.requestApproval(item.id, { request: "approve the run gate", ref: `workflow-gate:def-x:run_9:${refGate}` });
    return item;
  }

  it("routes APPROVE to resolve-gate, parses defId/runId/gateRef, sets approved, does NOT run native transition", async () => {
    const item = mirrored("gate-ref");
    const calls: Array<{ workflowId: string; runId: string; decision: string }> = [];
    const r = await approvals.decideWorkItemApproval(
      { id: item.id, decision: "approve" },
      {
        resolveWorkflowGate: async (workflowId, runId, decision) => {
          calls.push({ workflowId, runId, decision });
          return { outcome: "resolved", runStatus: "completed" };
        },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mirrored).toBe(true);
    expect(calls).toEqual([{ workflowId: "def-x", runId: "run_9", decision: "approve" }]);
    expect(r.item.approvalState).toBe("approved");
    // the module does NOT drive status for a mirror — the run engine + terminal reflect do
    expect(store.listWorkItemEvents(item.id).some((e) => e.kind === "status_change")).toBe(false);
  });

  it("preserves a gate ref that itself contains colons", async () => {
    const item = mirrored("a:b:c");
    const calls: Array<{ workflowId: string; runId: string }> = [];
    await approvals.decideWorkItemApproval(
      { id: item.id, decision: "approve" },
      {
        resolveWorkflowGate: async (workflowId, runId) => {
          calls.push({ workflowId, runId });
          return { outcome: "resolved" };
        },
      },
    );
    expect(calls).toEqual([{ workflowId: "def-x", runId: "run_9" }]);
  });

  it("routes REJECT to resolve-gate and marks rejected", async () => {
    const item = mirrored("g");
    const r = await approvals.decideWorkItemApproval(
      { id: item.id, decision: "reject", note: "not yet" },
      { resolveWorkflowGate: async () => ({ outcome: "resolved", runStatus: "failed" }) },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.approvalState).toBe("rejected");
    expect(r.mirrored).toBe(true);
  });

  it("run-not-parked → not decided, surfaces the run status", async () => {
    const item = mirrored("g");
    const r = await approvals.decideWorkItemApproval(
      { id: item.id, decision: "approve" },
      { resolveWorkflowGate: async () => ({ outcome: "not-parked", runStatus: "running" }) },
    );
    expect(r).toMatchObject({ ok: false, code: "run-not-parked", runStatus: "running" });
    // the approval was NOT cleared — still pending for a retry
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
  });

  it("run-not-found → not decided", async () => {
    const item = mirrored("g");
    const r = await approvals.decideWorkItemApproval(
      { id: item.id, decision: "approve" },
      { resolveWorkflowGate: async () => ({ outcome: "not-found" }) },
    );
    expect(r).toMatchObject({ ok: false, code: "run-not-found" });
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
  });

  it("evidence-root-missing when a mirror decision has no resolve hook wired", async () => {
    const item = mirrored("g");
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve" }, {});
    expect(r).toMatchObject({ ok: false, code: "evidence-root-missing" });
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
  });
});
