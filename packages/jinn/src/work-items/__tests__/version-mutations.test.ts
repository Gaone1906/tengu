import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-version-mutations-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Registry = typeof import("../../sessions/registry.js");
type Transitions = typeof import("../transitions.js");
type Approvals = typeof import("../approvals.js");
type Reconcile = typeof import("../reconcile.js");

let store: Store;
let registry: Registry;
let transitions: Transitions;
let approvals: Approvals;
let reconcile: Reconcile;

beforeAll(async () => {
  store = await import("../store.js");
  registry = await import("../../sessions/registry.js");
  transitions = await import("../transitions.js");
  approvals = await import("../approvals.js");
  reconcile = await import("../reconcile.js");
  (await import("../../shared/db.js")).initDb();
});

describe("Todo version mutation sensitivity", () => {
  it("increments legacy/internal metadata writes once and leaves an exact no-op silent", () => {
    const item = store.createWorkItem({ title: "metadata", priority: 1 });
    expect(store.updateWorkItem(item.id, { priority: 2 }, "operator")?.version).toBe(2);
    const eventCount = store.listWorkItemEvents(item.id).length;

    expect(store.updateWorkItem(item.id, { priority: 2 }, "operator")?.version).toBe(2);
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventCount);
  });

  it("increments a real session link once and leaves an exact re-link silent", () => {
    const item = store.createWorkItem({ title: "link" });
    const session = registry.createSession({ engine: "codex", source: "web", sourceRef: "version-link" });

    store.linkSession(item.id, session.id);
    expect(store.getWorkItem(item.id)?.version).toBe(2);
    store.linkSession(item.id, session.id);
    expect(store.getWorkItem(item.id)?.version).toBe(2);
  });

  it("increments standalone note/verification state but not an audit-only visibility annotation", () => {
    const item = store.createWorkItem({ title: "events" });
    store.appendWorkItemEvent({ workItemId: item.id, kind: "note", detail: { note: "operator-visible" } });
    expect(store.getWorkItem(item.id)?.version).toBe(2);
    store.appendWorkItemEvent({ workItemId: item.id, kind: "verify_result", detail: { verdict: "pass" } });
    expect(store.getWorkItem(item.id)?.version).toBe(3);
    store.appendWorkItemEvent({
      workItemId: item.id,
      kind: "note",
      detail: { visibilityDelivery: true },
      versionEffect: "audit",
    });
    expect(store.getWorkItem(item.id)?.version).toBe(3);
  });

  it("increments status transitions and assignment exactly once per actual change", () => {
    const statusItem = store.createWorkItem({ title: "status" });
    expect(transitions.transition(statusItem.id, "executing", "operator", { human: true }).item.version).toBe(2);
    expect(transitions.transition(statusItem.id, "executing", "operator", { human: true }).item.version).toBe(2);

    const assigned = store.createWorkItem({ title: "assign" });
    expect(transitions.assignWorkItem(assigned.id, "worker", "platform", "operator")?.version).toBe(2);
    const eventCount = store.listWorkItemEvents(assigned.id).length;
    expect(transitions.assignWorkItem(assigned.id, "worker", "platform", "operator")?.version).toBe(2);
    expect(store.listWorkItemEvents(assigned.id)).toHaveLength(eventCount);
  });

  it("increments approval request, escalation, and decision while keeping exact retries silent", async () => {
    const item = store.createWorkItem({ title: "approval" });
    expect(approvals.requestApproval(item.id, { request: "approve", target: "reviewer" }).version).toBe(2);
    expect(approvals.requestApproval(item.id, { request: "approve", target: "reviewer" }).version).toBe(2);
    expect(approvals.escalateApproval(item.id, "reviewer", "needs operator").version).toBe(3);
    const eventCount = store.listWorkItemEvents(item.id).length;
    expect(approvals.escalateApproval(item.id, "reviewer", "needs operator").version).toBe(3);
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventCount);

    const decided = await approvals.decideWorkItemApproval({
      id: item.id,
      decision: "approve",
      decidedBy: "reviewer",
    });
    expect(decided.ok && decided.item.version).toBe(4);
  });

  it("increments reconciler-derived lifecycle state and leaves a settled repeat silent", () => {
    const item = store.createWorkItem({ title: "reconcile", source: "session" });
    const session = registry.createSession({ engine: "codex", source: "web", sourceRef: "version-reconcile" });
    store.linkSession(item.id, session.id);
    registry.updateSession(session.id, { status: "running" });

    const first = reconcile.reconcileWorkItem(item.id);
    expect(first).toMatchObject({ changed: true, item: { status: "executing", version: 3 } });
    expect(reconcile.reconcileWorkItem(item.id)).toMatchObject({ changed: false, item: { version: 3 } });
  });

});
