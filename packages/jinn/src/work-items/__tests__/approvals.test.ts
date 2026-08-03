import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB (SESSIONS_DB resolves from JINN_HOME at module load) —
// keep the suite off the live DB. Set BEFORE importing the store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-appr-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Store = typeof import("../store.js");
type Approvals = typeof import("../approvals.js");
type ApprovalAuthority = typeof import("../../gateway/approval-authority.js");
let store: Store;
let approvals: Approvals;
let approvalAuthority: ApprovalAuthority;

beforeAll(async () => {
  store = await import("../store.js");
  approvals = await import("../approvals.js");
  approvalAuthority = await import("../../gateway/approval-authority.js");
  (await import("../../shared/db.js")).initDb();
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

/* ── approvals off-row (Todos v2 slice 4) — the work_item_approvals table ───── */

describe("approvals off-row — writes land in work_item_approvals, columns stay frozen", () => {
  function rawColumns(id: string): Record<string, unknown> {
    return dbModule
      .initDb()
      .prepare(
        `SELECT approval_state, approval_request, approval_ref, approval_target,
                approval_target_kind, approval_escalated_at, approval_decided_by, approval_decided_at
           FROM work_items WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>;
  }

  function expectColumnsFrozenNull(id: string): void {
    const cols = rawColumns(id);
    for (const [column, value] of Object.entries(cols)) {
      expect(value, `${column} must stay frozen (never written post-slice-4)`).toBeNull();
    }
  }

  it("request writes ONLY the new table; the legacy approval_* columns never change", () => {
    const item = store.createWorkItem({ title: "Off-row request", status: "in_review", source: "human" });
    const out = approvals.requestApproval(item.id, { request: "gate?", ref: "opaque-ref", target: null, actor: "session:sX" });
    // The returned WorkItem still reads as pending (dual-read), but the columns are untouched.
    expect(out.approvalState).toBe("pending");
    expect(out.approvalRef).toBe("opaque-ref");
    expectColumnsFrozenNull(item.id);
    const row = approvals.currentApproval(item.id)!;
    expect(row.state).toBe("pending");
    expect(row.request).toBe("gate?");
    expect(row.ref).toBe("opaque-ref");
    expect(row.target).toBeNull();
    expect(row.targetKind).toBe("none");
    expect(row.requestedBy).toBe("session:sX");
    expect(row.requestedAt).toBeTruthy();
    expect(row.decidedBy).toBeNull();
    expect(row.decidedAt).toBeNull();
    // version still advances exactly once per effective request
    expect(out.version).toBe(item.version + 1);
  });

  it("decide + escalate write the pending row (note included); columns stay frozen", async () => {
    const item = store.createWorkItem({ title: "Off-row decide", status: "backlog", source: "human" });
    approvals.requestApproval(item.id, { request: "plan ok?", target: null });
    const escalated = approvals.escalateApproval(item.id, "coo", "needs the operator");
    expect(escalated.approvalEscalatedAt).toBeTruthy();
    expect(approvals.currentApproval(item.id)!.escalatedAt).toBeTruthy();
    const r = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", note: "fine", decidedBy: "coo" });
    expect(r.ok).toBe(true);
    const row = approvals.currentApproval(item.id)!;
    expect(row.state).toBe("approved");
    expect(row.decidedBy).toBe("coo");
    expect(row.decidedAt).toBeTruthy();
    expect(row.note).toBe("fine");
    expectColumnsFrozenNull(item.id);
  });

  it("keeps approval history: a fresh request after a decision is a NEW row; current = pending else latest decided", async () => {
    const item = store.createWorkItem({ title: "History", status: "backlog", source: "human" });
    approvals.requestApproval(item.id, { request: "round one", target: null });
    await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "no", decidedBy: "coo" });
    approvals.requestApproval(item.id, { request: "round two", target: null });

    const history = approvals.listApprovals(item.id);
    expect(history.length).toBe(2);
    expect(history[0].request).toBe("round one");
    expect(history[0].state).toBe("rejected");
    expect(history[1].request).toBe("round two");
    expect(history[1].state).toBe("pending");

    // current = the pending row while one exists
    expect(approvals.currentApproval(item.id)!.request).toBe("round two");

    // …and the latest DECIDED row once it is decided
    await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", decidedBy: "coo" });
    const current = approvals.currentApproval(item.id)!;
    expect(current.request).toBe("round two");
    expect(current.state).toBe("approved");

    // the dual-read WorkItem view tracks the current row
    const roundTrip = store.getWorkItem(item.id)!;
    expect(roundTrip.approvalState).toBe("approved");
    expect(roundTrip.approvalRequest).toBe("round two");
  });

  it("re-request while pending overwrites the pending row in place — no second row", () => {
    const item = store.createWorkItem({ title: "Overwrite pending", status: "assigned", source: "delegation" });
    approvals.requestApproval(item.id, { request: "v1 text", target: null });
    approvals.requestApproval(item.id, { request: "v2 text", target: null });
    const history = approvals.listApprovals(item.id);
    expect(history.length).toBe(1);
    expect(history[0].request).toBe("v2 text");
    expect(history[0].state).toBe("pending");
  });

  it("the DB refuses a second pending row per item (uq_wap_pending partial unique index)", () => {
    const item = store.createWorkItem({ title: "Unique pending", status: "backlog", source: "human" });
    approvals.requestApproval(item.id, { request: "first", target: null });
    expect(() =>
      dbModule
        .initDb()
        .prepare(
          `INSERT INTO work_item_approvals (id, work_item_id, state, request, requested_by, requested_at)
           VALUES ('wap_ffffffffffff', ?, 'pending', 'raced second request', 'test', '2026-07-23T00:00:00.000Z')`,
        )
        .run(item.id),
    ).toThrow(/UNIQUE/);
    expect(approvals.listApprovals(item.id).length).toBe(1);
  });

  it("an idempotent-hit create returns the overlaid approval state (review F1)", () => {
    const item = store.createWorkItem({
      title: "Idempotent overlay",
      status: "executing",
      source: "delegation",
      sourceRef: "delegate:sess-f1:idempotency:1",
    });
    approvals.requestApproval(item.id, { request: "gate the retry", target: null });
    // A retry with the same (source, sourceRef) returns the EXISTING row — and
    // it must leave the module hydrated like every other WorkItem read.
    const replay = store.createWorkItem({
      title: "Idempotent overlay",
      status: "executing",
      source: "delegation",
      sourceRef: "delegate:sess-f1:idempotency:1",
    });
    expect(replay.id).toBe(item.id);
    expect(replay.approvalState).toBe("pending");
    expect(replay.approvalRequest).toBe("gate the retry");
  });

  it("needsAttentionFor reads pending approvals from the new table", () => {
    const item = store.createWorkItem({ title: "Attention via table", status: "assigned", source: "delegation" });
    approvals.requestApproval(item.id, { request: "sign-off", target: "attention-target" });
    const hits = store.listWorkItems({ needsAttentionFor: "attention-target" });
    expect(hits.some((i) => i.id === item.id)).toBe(true);
    expectColumnsFrozenNull(item.id);
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
