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

  it("persists an opaque approval ref without assigning cross-domain meaning", () => {
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
    expect(() => approvals.requestApproval("JIN-999", { request: "x" })).toThrow();
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

/* ── raw decision door closure ─────────────────────────────────────────────── */

describe("raw approval decision door", () => {
  it("does not export the low-level decideApproval writer", () => {
    expect("decideApproval" in approvals).toBe(false);
  });
  it("does not export a Workflow mirror decision writer", () => {
    expect("recordMirroredApprovalDecision" in approvals).toBe(false);
  });
});

/* ── decideWorkItemApproval — the fixed consequence rules (§1.3, item 3) ───────── */

describe("decideWorkItemApproval — native consequence rules", () => {
  it("not-found for an unknown item", async () => {
    const r = await approvals.decideWorkItemApproval({ id: "JIN-999", decision: "approve" });
    expect(r).toMatchObject({ ok: false, code: "not-found" });
  });

  it("no-pending when the item has no pending approval", async () => {
    const item = store.createWorkItem({ title: "No approval", status: "in_review", source: "human" });
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve" });
    expect(r).toMatchObject({ ok: false, code: "no-pending" });
  });

  it("APPROVE + in_review → done (approval_decided THEN status_change), not mirrored", async () => {
    const item = store.createWorkItem({ title: "Approve to done", status: "in_review", source: "human" });
    approvals.requestApproval(item.id, { request: "close it?" });
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", note: "ship" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).not.toHaveProperty("mirrored");
    expect(r).not.toHaveProperty("runStatus");
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
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve" });
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
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "fix the tests" });
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
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "still wrong" });
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
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "rethink" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.status).toBe("backlog");
    expect(r.item.approvalState).toBe("rejected");
    expect(store.listWorkItemEvents(item.id).some((e) => e.kind === "status_change")).toBe(false);
  });
});

describe("Todo approvals ignore historical Workflow-looking refs", () => {
  it("applies the native decision and archive rules without Workflow routing", async () => {
    const decidedItem = store.createWorkItem({ title: "Historical ref", status: "in_review", source: "workflow" });
    approvals.requestApproval(decidedItem.id, { request: "approve", ref: "workflow-gate:old:def:gate" });
    const decided = await approvals.decideWorkItemApproval({ id: decidedItem.id, decision: "approve", decidedBy: "coo" });
    expect(decided).toMatchObject({ ok: true, item: { status: "done", approvalState: "approved" }, escalated: false });
    expect(decided).not.toHaveProperty("mirrored");
    expect(decided).not.toHaveProperty("runStatus");

    const archivedItem = store.createWorkItem({ title: "Historical archive", status: "in_review", source: "workflow" });
    approvals.requestApproval(archivedItem.id, { request: "approve", ref: "workflow-gate:old:def:gate" });
    expect(approvals.archiveWorkItem(archivedItem.id, "coo", { human: true })).toMatchObject({
      status: "cancelled",
      approvalState: "rejected",
    });
  });
});
