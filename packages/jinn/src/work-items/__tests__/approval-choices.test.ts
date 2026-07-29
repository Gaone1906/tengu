import { describe, it, expect, beforeAll, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB (SESSIONS_DB resolves from JINN_HOME at module load) —
// keep the suite off the live DB. Set BEFORE importing the store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-choice-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Approvals = typeof import("../approvals.js");
type Reg = typeof import("../../sessions/registry.js");
let store: Store;
let approvals: Approvals;
let reg: Reg;

const VARIANTS = ["variant-a", "variant-b", "variant-c"];

beforeAll(async () => {
  store = await import("../store.js");
  approvals = await import("../approvals.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
});

afterEach(() => {
  approvals.setTodoApprovalDecisionListener(null);
});

function gated(options?: string[]) {
  const item = store.createWorkItem({ title: "Pick a variant", status: "in_review", source: "delegation" });
  approvals.requestApproval(item.id, { request: "Which variant ships?", ...(options ? { options } : {}) });
  return item;
}

describe("choice approvals — offering options", () => {
  it("stores the offered options on the pending approval", () => {
    const item = gated(VARIANTS);
    const current = approvals.currentApproval(item.id)!;
    expect(current.options).toEqual(VARIANTS);
    expect(current.choice).toBeNull();
  });

  it("leaves a plain approval with no options", () => {
    const item = gated();
    expect(approvals.currentApproval(item.id)!.options).toBeNull();
  });

  it("treats an empty option list as a plain approval", () => {
    const item = gated([]);
    expect(approvals.currentApproval(item.id)!.options).toBeNull();
  });

  it("rejects duplicate, blank, and over-long option labels", () => {
    const item = store.createWorkItem({ title: "Bad options", status: "in_review", source: "delegation" });
    expect(() => approvals.requestApproval(item.id, { request: "?", options: ["a", "a"] })).toThrow(approvals.ApprovalChoiceError);
    expect(() => approvals.requestApproval(item.id, { request: "?", options: ["a", "  "] })).toThrow(approvals.ApprovalChoiceError);
    expect(() => approvals.requestApproval(item.id, { request: "?", options: ["a", "x".repeat(81)] })).toThrow(approvals.ApprovalChoiceError);
    expect(() => approvals.requestApproval(item.id, { request: "?", options: Array.from({ length: 9 }, (_, i) => `o${i}`) }))
      .toThrow(approvals.ApprovalChoiceError);
  });

  it("re-offering the identical option set stays idempotent (no version bump)", () => {
    const item = gated(VARIANTS);
    const before = store.getWorkItem(item.id)!.version;
    approvals.requestApproval(item.id, { request: "Which variant ships?", options: VARIANTS });
    expect(store.getWorkItem(item.id)!.version).toBe(before);
  });

  it("re-offering a DIFFERENT option set replaces the options in place", () => {
    const item = gated(VARIANTS);
    approvals.requestApproval(item.id, { request: "Which variant ships?", options: ["only-this"] });
    expect(approvals.currentApproval(item.id)!.options).toEqual(["only-this"]);
  });
});

describe("choice approvals — deciding", () => {
  it("approving with an offered choice records it and applies the done consequence", async () => {
    const item = gated(VARIANTS);
    const result = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", choice: "variant-b" });
    expect(result.ok).toBe(true);
    const current = approvals.currentApproval(item.id)!;
    expect(current.choice).toBe("variant-b");
    expect(current.state).toBe("approved");
    expect(store.getWorkItem(item.id)!.status).toBe("done");
  });

  it("records the choice on the approval_decided event", async () => {
    const item = gated(VARIANTS);
    await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", choice: "variant-c" });
    const decided = store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_decided").at(-1)!;
    expect(decided.detail).toMatchObject({ decision: "approve", choice: "variant-c" });
  });

  it("refuses an approve with NO choice when options were offered", async () => {
    const item = gated(VARIANTS);
    const result = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve" });
    expect(result).toMatchObject({ ok: false, code: "invalid-choice" });
    // The gate is untouched — not silently defaulted, not resolved.
    expect(approvals.currentApproval(item.id)!.state).toBe("pending");
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");
  });

  it("refuses a choice that is not one of the offered options", async () => {
    const item = gated(VARIANTS);
    const result = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", choice: "variant-z" });
    expect(result).toMatchObject({ ok: false, code: "invalid-choice" });
    expect(approvals.currentApproval(item.id)!.state).toBe("pending");
  });

  it("refuses a choice on an approval that offers none", async () => {
    const item = gated();
    const result = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", choice: "variant-a" });
    expect(result).toMatchObject({ ok: false, code: "invalid-choice" });
  });

  it("refuses a choice on a reject", async () => {
    const item = gated(VARIANTS);
    const result = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", choice: "variant-a" });
    expect(result).toMatchObject({ ok: false, code: "invalid-choice" });
  });

  it("allows rejecting a choice gate without picking anything", async () => {
    const item = gated(VARIANTS);
    const result = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject" });
    expect(result.ok).toBe(true);
    expect(approvals.currentApproval(item.id)!.state).toBe("rejected");
  });
});

describe("choice approvals — the decision bridge", () => {
  it("notifies the listener with the approval, decision, and picked choice", async () => {
    const seen: Array<{ ref: string | null; choice: string | null; decision: string }> = [];
    approvals.setTodoApprovalDecisionListener(({ approval, decision }) => {
      seen.push({ ref: approval.ref, choice: approval.choice, decision });
    });
    const item = store.createWorkItem({ title: "Bridged", status: "in_review", source: "delegation" });
    approvals.requestApproval(item.id, { request: "Pick", ref: "workflow:wf_1:run_1:approve1", options: VARIANTS });
    await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", choice: "variant-a" });
    expect(seen).toEqual([{ ref: "workflow:wf_1:run_1:approve1", choice: "variant-a", decision: "approve" }]);
  });

  it("a throwing listener never fails the decision that already committed", async () => {
    approvals.setTodoApprovalDecisionListener(() => { throw new Error("consumer blew up"); });
    const item = gated(VARIANTS);
    const result = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", choice: "variant-a" });
    expect(result.ok).toBe(true);
    expect(store.getWorkItem(item.id)!.status).toBe("done");
  });
});
