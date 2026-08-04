import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB — off the live DB. Set BEFORE importing the store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-atomic-"));
process.env.JINN_HOME = tmp;

// GRS-021b QA finding 2 — the native approval decision + its status consequence
// must be ONE transaction. We force the STATUS write to fail and assert the
// approval decision ALSO rolls back (no half-applied approved+in_review, no orphan
// approval_decided event). `vi.hoisted` shares a toggle with the hoisted mock.
const inject = vi.hoisted(() => ({ failTransition: false }));
vi.mock("../transitions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transitions.js")>();
  return {
    ...actual,
    transition: (...args: Parameters<typeof actual.transition>) => {
      if (inject.failTransition) throw new Error("injected status-write failure");
      return actual.transition(...args);
    },
  };
});

type Store = typeof import("../store.js");
type Approvals = typeof import("../approvals.js");
let store: Store;
let approvals: Approvals;

beforeAll(async () => {
  store = await import("../store.js");
  approvals = await import("../approvals.js");
  (await import("../../shared/db.js")).initDb();
});

function pendingInReview(id: string) {
  const item = store.createWorkItem({ title: id, status: "in_review", source: "human" });
  approvals.requestApproval(item.id, { request: "decide?" });
  return item.id;
}

describe("native approval decision atomicity (QA finding 2)", () => {
  it("happy path: approve+in_review commits the decision AND the status consequence together", async () => {
    inject.failTransition = false;
    const id = pendingInReview("atomic-ok");
    const r = await approvals.decideWorkItemApproval({ id, decision: "approve", note: "ship" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.status).toBe("done");
    expect(r.item.approvalState).toBe("approved");
    const kinds = store.listWorkItemEvents(id).map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(["approval_decided", "status_change"]);
  });

  it("a failing STATUS write rolls back the WHOLE decision — no approved+in_review, no orphan event", async () => {
    const id = pendingInReview("atomic-rollback");
    inject.failTransition = true;
    await expect(approvals.decideWorkItemApproval({ id, decision: "approve", note: "ship" })).rejects.toThrow(
      "injected status-write failure",
    );
    inject.failTransition = false;

    // The decision rolled back with the failed status write: still pending, no
    // approval_decided event, no status_change — either the whole thing lands or none.
    const item = store.getWorkItem(id)!;
    expect(item.status).toBe("in_review");
    expect(item.approvalState).toBe("pending");
    // slice 4: the work_item_approvals row itself rolled back to undecided
    const row = approvals.currentApproval(id)!;
    expect(row.state).toBe("pending");
    expect(row.decidedBy).toBeNull();
    expect(row.decidedAt).toBeNull();
    const kinds = store.listWorkItemEvents(id).map((e) => e.kind);
    expect(kinds).not.toContain("approval_decided");
    expect(kinds).not.toContain("status_change");
    expect(kinds).toEqual(["created", "approval_requested"]);

    // And the item is still cleanly decidable once the fault clears.
    const r = await approvals.decideWorkItemApproval({ id, decision: "approve" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.status).toBe("done");
  });

  it("a reject bounce is atomic too — a failing status write leaves rounds and approval untouched", async () => {
    const id = pendingInReview("atomic-reject");
    inject.failTransition = true;
    await expect(approvals.decideWorkItemApproval({ id, decision: "reject", note: "no" })).rejects.toThrow(
      "injected status-write failure",
    );
    inject.failTransition = false;
    const item = store.getWorkItem(id)!;
    expect(item.status).toBe("in_review");
    expect(item.approvalState).toBe("pending");
    expect(item.rounds).toBe(0); // rounds++ rolled back with the bounce
    expect(store.listWorkItemEvents(id).map((e) => e.kind)).toEqual(["created", "approval_requested"]);
  });
});
