import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wf-parked-"));
process.env.JINN_HOME = tmp;

const delivered: string[] = [];

// The delivery lane is exercised for real down to the durable `callback_deliveries`
// row; only the two outbound edges (an HTTP post to the gateway, a connector send)
// are stubbed, because those leave the process.
vi.mock("../../sessions/callbacks.js", () => ({
  notifyOperatorChannel: () => { throw new Error("unexpected operator notification"); },
  deliverClaimedSessionDelivery: async (id: string) => { delivered.push(id); return "accepted" as const; },
}));

type Surface = typeof import("../workflow-todo-surface.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Registry = typeof import("../../sessions/registry.js");

let surface: Surface;
let store: Store;
let approvals: Approvals;
let registry: Registry;
let db: import("better-sqlite3").Database;

const GATE = "Verification passed. Approving merges this branch into main.";

function parkedTodo(title: string, target?: string | null, operatorOnly = false): string {
  const id = store.createWorkItem({ title, source: "human", status: "assigned" }).id;
  approvals.requestApproval(id, { request: GATE, ref: "workflow:jinn-build:run_abc:land-approval",
    target, operatorOnly, actor: "workflow" });
  return id;
}

function notifyParked(todoId: string): void {
  surface.workflowTodoApprovals(() => {}).notifyParked({
    todoId, workflowId: "jinn-build", runId: "run_abc", nodeId: "land-approval",
    request: GATE, ref: "workflow:jinn-build:run_abc:land-approval",
  });
}

function pendingDeliveries() {
  return registry.listPendingSessionDeliveries();
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  registry = await import("../../sessions/registry.js");
  surface = await import("../workflow-todo-surface.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  delivered.length = 0;
  db.prepare("DELETE FROM callback_deliveries").run();
  db.prepare("DELETE FROM sessions").run();
});

describe("parked-gate session notifications", () => {
  it("wakes the routed employee's session, naming the Todo, the run, and the decision", () => {
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, employee, created_at, last_activity)
       VALUES ('sess-coo', 'claude', 'web', 'web:coo', 'idle', 'a-lead', '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z')`,
    ).run();
    const id = parkedTodo("run parked on its merge gate", "a-lead");

    notifyParked(id);

    const queued = pendingDeliveries();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      targetSessionId: "sess-coo",
      sourceKind: "workflow-run",
      sourceId: "run_abc",
      deliveryKind: "workflow-approval-parked",
    });
    expect(queued[0]!.payload.message).toContain(id);
    expect(queued[0]!.payload.message).toContain("run_abc");
    expect(queued[0]!.payload.message).toContain(GATE);
    expect(delivered).toEqual([queued[0]!.id]);
  });

  it("notifies once per gate, however many times the mirror re-runs", () => {
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, employee, created_at, last_activity)
       VALUES ('sess-coo', 'claude', 'web', 'web:coo', 'idle', 'a-lead', '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z')`,
    ).run();
    const id = parkedTodo("re-mirrored on every recovery sweep", "a-lead");

    notifyParked(id);
    notifyParked(id);
    notifyParked(id);

    expect(pendingDeliveries()).toHaveLength(1);
  });

  it("does not wake any top-level chat for a gate routed to the virtual root", () => {
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
       VALUES
         ('sess-old', 'claude', 'web', 'web:old', 'idle', '2026-07-30T08:00:00.000Z', '2026-07-30T08:00:00.000Z'),
         ('sess-middle', 'codex', 'web', 'web:middle', 'idle', '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z'),
         ('sess-recent', 'claude', 'web', 'web:recent', 'running', '2026-07-30T10:00:00.000Z', '2026-07-30T10:00:00.000Z')`,
    ).run();
    const id = parkedTodo("gate routed to the virtual COO root");

    notifyParked(id);

    expect(approvals.currentApproval(id)).toMatchObject({ targetKind: "virtual" });
    expect(pendingDeliveries()).toEqual([]);
  });

  it("does not wake an employee session for an operator-only gate", () => {
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, employee, created_at, last_activity)
       VALUES ('sess-employee', 'claude', 'web', 'web:employee', 'idle', 'a-lead', '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z')`,
    ).run();
    const id = parkedTodo("operator decides the merge gate", "a-lead", true);

    notifyParked(id);

    expect(pendingDeliveries()).toEqual([]);
  });

  it("does not mistake an employee's plain child session for the operator's chat", () => {
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, parent_session_id, created_at, last_activity)
       VALUES ('sess-child', 'claude', 'web', 'web:child', 'idle', 'sess-parent', '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z')`,
    ).run();
    const id = parkedTodo("only an employee-less CHILD session exists");

    notifyParked(id);

    expect(pendingDeliveries()).toEqual([]);
  });

  it("stays silent when the routed employee has only an errored session", () => {
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, employee, created_at, last_activity)
       VALUES ('sess-dead', 'claude', 'web', 'web:dead', 'error', 'a-lead', '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z')`,
    ).run();
    const id = parkedTodo("routed employee is wedged", "a-lead");

    notifyParked(id);

    expect(pendingDeliveries()).toEqual([]);
  });
});
