import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  ACTIVITY_OPERATION_HEADER,
  ACTIVITY_TOOL_HEADER,
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-chat-activity-"));
const evidence = path.join(home, "evidence");
process.env.JINN_HOME = home;
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = evidence;
fs.mkdirSync(path.join(home, "org", "platform"), { recursive: true });
fs.writeFileSync(path.join(home, "org", "platform", "department.yaml"), "name: platform\n");
fs.writeFileSync(
  path.join(home, "org", "platform", "coo.yaml"),
  "name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: default\npersona: Coordinates generic work.\n",
);
fs.writeFileSync(
  path.join(home, "org", "platform", "worker.yaml"),
  "name: worker\ndisplayName: Worker\ndepartment: platform\nrank: employee\nreportsTo: coo\nengine: codex\nmodel: default\npersona: Executes generic work.\n",
);

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type ChatActivity = typeof import("../chat-activity.js");
let api: Api;
let registry: Registry;
let chatActivity: ChatActivity;
let coo: import("../../shared/types.js").Session;
let worker: import("../../shared/types.js").Session;
let emitted: Array<{ event: string; payload: any }> = [];

function makeRes(options?: { loseResponse?: boolean }) {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) {
      if (options?.loseResponse) throw new Error("socket lost after commit");
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: {
      host: "gateway.test",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...headers,
    },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const context = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

function toolHeaders(session: import("../../shared/types.js").Session, toolName: string, operationId = crypto.randomUUID()) {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: session.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(session.id),
    [ACTIVITY_OPERATION_HEADER]: operationId,
    [ACTIVITY_TOOL_HEADER]: toolName,
  };
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  options?: { loseResponse?: boolean },
) {
  const capture = makeRes(options);
  await api.handleApiRequest(request(method, url, body, headers), capture.res, context);
  return capture;
}

function activityBlocks(sessionId: string) {
  return registry.getMessages(sessionId).flatMap((message) => message.blocks ?? []);
}

function companyEvents() {
  return emitted.filter((entry) => entry.event === "company:changed");
}

const definition = {
  id: "receipt-workflow",
  title: "Receipt Workflow",
  nodes: [
    { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, trigger: { kind: "manual" } },
    { id: "prepare", type: "step", label: "Prepare", position: { x: 0, y: 120 }, instructions: "Prepare the receipt." },
    { id: "gate", type: "gate", label: "Approve", position: { x: 0, y: 240 }, gate: { kind: "approval", approvalRef: "receipt", description: "Approve the receipt." } },
    { id: "deliver", type: "step", label: "Deliver", position: { x: 0, y: 360 }, actor: { kind: "engine", ref: "codex" }, instructions: "Deliver the receipt." },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "prepare", kind: "sequence" },
    { id: "e2", from: "prepare", to: "gate", kind: "sequence" },
    { id: "e3", from: "gate", to: "deliver", kind: "sequence" },
  ],
};

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  chatActivity = await import("../chat-activity.js");
  registry.initDb();
  coo = registry.createSession({ engine: "codex", source: "web", sourceRef: "activity-coo", employee: "coo" });
  worker = registry.createSession({ engine: "codex", source: "web", sourceRef: "activity-worker", employee: "worker" });
});

beforeEach(() => {
  emitted = [];
  registry.initDb().exec("DELETE FROM work_item_events; DELETE FROM work_items; DELETE FROM messages;");
  fs.rmSync(path.join(evidence, "workflows"), { recursive: true, force: true });
  fs.rmSync(path.join(evidence, "reports"), { recursive: true, force: true });
  fs.mkdirSync(evidence, { recursive: true });
});

describe("persisted Todo and Workflow operation activity", () => {
  it("keeps independent stable Todo and Workflow definition blocks and emits once after each mutation", async () => {
    const createdTodo = await call("POST", "/api/work-items", { title: "Ship receipt" }, toolHeaders(worker, "create_work_item"));
    expect(createdTodo.status).toBe(201);
    const item = createdTodo.body.workItem;
    expect(createdTodo.body.activityReceiptId).toBe(`todo:${item.id}`);

    const assigned = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: "worker" }, toolHeaders(worker, "assign_work_item"));
    expect(assigned.status).toBe(200);
    const transitioned = await call("POST", `/api/work-items/${item.id}/status`, { status: "executing" }, toolHeaders(worker, "update_work_item"));
    expect(transitioned.status).toBe(200);

    const createdWorkflow = await call("POST", "/api/workflow-definitions", definition, toolHeaders(coo, "create_workflow"));
    expect(createdWorkflow.status).toBe(201);
    expect(createdWorkflow.body.activityReceiptId).toBe("workflow-definition:receipt-workflow");
    const updatedWorkflow = await call(
      "PUT",
      "/api/workflow-definitions/receipt-workflow",
      { title: "Receipt Workflow v2", expectedVersion: 1 },
      toolHeaders(coo, "update_workflow"),
    );
    expect(updatedWorkflow.status).toBe(200);

    const todoBlocks = activityBlocks(worker.id).filter((block) => block.id === `todo:${item.id}`);
    const workflowBlocks = activityBlocks(coo.id).filter((block) => block.id === "workflow-definition:receipt-workflow");
    expect(todoBlocks).toHaveLength(1);
    expect(todoBlocks[0]).toMatchObject({
      type: "todo-activity",
      version: transitioned.body.workItem.version,
      payload: { todoId: item.id, action: "status-transitioned", status: "executing" },
    });
    expect(workflowBlocks).toHaveLength(1);
    expect(workflowBlocks[0]).toMatchObject({
      type: "workflow-definition",
      version: 2,
      payload: { workflowId: "receipt-workflow", action: "updated" },
    });
    expect(todoBlocks[0].payload).not.toHaveProperty("workflowId");
    expect(workflowBlocks[0].payload).not.toHaveProperty("todoId");
    expect(companyEvents()).toHaveLength(5);
  });

  it("emits browser mutations without a transcript receipt and ignores forged activity headers", async () => {
    const browser = await call("POST", "/api/workflow-definitions", definition, {
      [ACTIVITY_OPERATION_HEADER]: crypto.randomUUID(),
      [ACTIVITY_TOOL_HEADER]: "create_workflow",
    });
    expect(browser.status).toBe(201);
    expect(browser.body).not.toHaveProperty("activityReceiptId");
    expect(activityBlocks(coo.id)).toEqual([]);
    expect(activityBlocks(worker.id)).toEqual([]);
    expect(companyEvents()).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ entity: "workflow-definition", id: "receipt-workflow" }),
    })]);
    expect(companyEvents()[0].payload).not.toHaveProperty("sessionId");
  });

  it("rejects a forged Session capability before persistence, receipt projection, or company emission", async () => {
    const forged = await call("POST", "/api/work-items", { title: "Forged" }, {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: worker.id,
      [CALLER_SESSION_CAPABILITY_HEADER]: "forged-capability",
      [ACTIVITY_OPERATION_HEADER]: crypto.randomUUID(),
      [ACTIVITY_TOOL_HEADER]: "create_work_item",
    });
    expect(forged.status).toBe(403);
    expect(companyEvents()).toEqual([]);
    expect(activityBlocks(worker.id)).toEqual([]);
  });

  it("patches the Task 5 run block on start/replay and the target definition block on trigger mutations", async () => {
    expect((await call("POST", "/api/workflow-definitions", definition, toolHeaders(coo, "create_workflow"))).status).toBe(201);
    emitted = [];

    const started = await call(
      "POST",
      "/api/workflow-definitions/receipt-workflow/run",
      { idempotencyKey: "receipt-run" },
      toolHeaders(coo, "start_workflow_run"),
    );
    expect(started.status).toBe(201);
    expect(started.body.activityReceiptId).toMatch(/^workflow-run:/);
    const runReceipt = started.body.activityReceiptId;
    expect(activityBlocks(coo.id).filter((block) => block.id === runReceipt)).toHaveLength(1);
    expect(companyEvents()).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ entity: "workflow-run", action: "started", runId: started.body.runId }),
    })]);

    const replay = await call(
      "POST",
      "/api/workflow-definitions/receipt-workflow/run",
      { idempotencyKey: "receipt-run" },
      toolHeaders(coo, "start_workflow_run"),
    );
    expect(replay.status).toBe(200);
    expect(replay.body.activityReceiptId).toBe(runReceipt);
    expect(activityBlocks(coo.id).filter((block) => block.id === runReceipt)).toHaveLength(1);
    expect(activityBlocks(coo.id).find((block) => block.id === runReceipt)).toMatchObject({ payload: { action: "replayed" } });
    expect(companyEvents()).toHaveLength(1);

    const edited = await call(
      "PATCH",
      `/api/workflow-definitions/receipt-workflow/runs/${started.body.runId}/pending-steps/deliver`,
      { prompt: "Deliver the persisted receipt." },
      toolHeaders(coo, "edit_workflow_run_step_prompt"),
    );
    expect(edited.status).toBe(200);
    expect(edited.body.activityReceiptId).toBe(runReceipt);
    const escalated = await call(
      "POST",
      `/api/workflow-definitions/receipt-workflow/runs/${started.body.runId}/gate-approval/escalate`,
      {},
      toolHeaders(coo, "escalate_workflow_gate"),
    );
    expect(escalated.status).toBe(200);
    expect(escalated.body.activityReceiptId).toBe(runReceipt);
    const decided = await call(
      "POST",
      `/api/workflow-definitions/receipt-workflow/runs/${started.body.runId}/resolve-gate`,
      { decision: "reject" },
      toolHeaders(coo, "resolve_workflow_gate"),
    );
    expect(decided.status).toBe(200);
    expect(decided.body.activityReceiptId).toBe(runReceipt);

    const cancellable = await call(
      "POST",
      "/api/workflow-definitions/receipt-workflow/run",
      { idempotencyKey: "receipt-cancel" },
      toolHeaders(coo, "start_workflow_run"),
    );
    expect(cancellable.status).toBe(201);
    const cancelled = await call(
      "POST",
      `/api/workflow-definitions/receipt-workflow/runs/${cancellable.body.runId}/cancel`,
      { reason: "No longer needed" },
      toolHeaders(coo, "cancel_workflow_run"),
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.activityReceiptId).toBe(cancellable.body.activityReceiptId);

    const trigger = await call("POST", "/api/workflow-triggers", {
      kind: "webhook",
      name: "receipt-event",
      event: "receipt.ready",
      targetWorkflowId: "receipt-workflow",
    }, toolHeaders(coo, "create_trigger"));
    expect(trigger.status).toBe(201);
    expect(trigger.body.activityReceiptId).toBe("workflow-definition:receipt-workflow");
    expect(activityBlocks(coo.id).find((block) => block.id === "workflow-definition:receipt-workflow")).toMatchObject({
      payload: { action: "trigger-created", workflowId: "receipt-workflow" },
    });

    const deleted = await call("DELETE", "/api/workflow-triggers/receipt-event", undefined, toolHeaders(coo, "delete_trigger"));
    expect(deleted.status).toBe(200);
    expect(deleted.body.activityReceiptId).toBe("workflow-definition:receipt-workflow");
    expect(activityBlocks(coo.id).filter((block) => block.id === "workflow-definition:receipt-workflow")).toHaveLength(1);
    expect(activityBlocks(coo.id).find((block) => block.id === "workflow-definition:receipt-workflow")).toMatchObject({
      payload: { action: "trigger-deleted" },
    });

    const pollScript = path.join(evidence, "receipt-poll.sh");
    fs.writeFileSync(pollScript, "#!/bin/sh\nprintf '%s' '{}'\n", "utf8");
    fs.chmodSync(pollScript, 0o700);
    const poll = await call("POST", "/api/workflow-triggers", {
      kind: "poll",
      name: "receipt-poll",
      event: "receipt.poll",
      targetWorkflowId: "receipt-workflow",
      command: pollScript,
      intervalSeconds: 60,
    }, toolHeaders(coo, "create_trigger"));
    expect(poll.status, JSON.stringify(poll.body)).toBe(201);
    const pollDecision = await call(
      "POST",
      "/api/workflow-triggers/receipt-poll/activation-approval",
      { decision: "approve" },
      toolHeaders(coo, "decide_poll_activation"),
    );
    expect(pollDecision.status).toBe(200);
    expect(pollDecision.body.activityReceiptId).toBe("workflow-definition:receipt-workflow");
    expect(activityBlocks(coo.id).find((block) => block.id === "workflow-definition:receipt-workflow")).toMatchObject({
      payload: { action: "trigger-approval-decided" },
    });
    expect(companyEvents().map((entry) => entry.payload.action)).toEqual([
      "started",
      "step-prompt-edited",
      "gate-approval-escalated",
      "gate-approval-decided",
      "started",
      "cancelled",
      "trigger-created",
      "trigger-deleted",
      "trigger-created",
      "trigger-approval-decided",
    ]);
  });

  it("treats equal versions as idempotent and refuses stale activity overwrites", async () => {
    const created = await call("POST", "/api/work-items", { title: "Monotonic" }, toolHeaders(worker, "create_work_item"));
    const item = created.body.workItem;
    const assigned = await call(
      "POST",
      `/api/work-items/${item.id}/assign`,
      { assignee: "worker" },
      toolHeaders(worker, "assign_work_item"),
    );
    const current = assigned.body.workItem;
    const stale = chatActivity.todoActivityBlock({ ...current, version: current.version - 1 }, "stale-overwrite");
    registry.applyBlockEnvelope(worker.id, stale, "stale");
    expect(activityBlocks(worker.id).find((block) => block.id === `todo:${item.id}`)).toMatchObject({
      version: current.version,
      payload: { action: "assigned" },
    });

    const equal = chatActivity.todoActivityBlock(current, "equal-version-replay");
    registry.applyBlockEnvelope(worker.id, equal, "equal");
    expect(activityBlocks(worker.id).filter((block) => block.id === `todo:${item.id}`)).toHaveLength(1);
    expect(activityBlocks(worker.id).find((block) => block.id === `todo:${item.id}`)).toMatchObject({
      version: current.version,
      payload: { action: "equal-version-replay" },
    });
  });

  it("persists before a lost response and an idempotent approval replay reuses the same receipt without a second event", async () => {
    const created = await call("POST", "/api/work-items", { title: "Approval receipt", assignee: "worker" }, toolHeaders(worker, "create_work_item"));
    const item = created.body.workItem;
    emitted = [];
    const headers = toolHeaders(worker, "request_work_item_approval");

    await expect(call(
      "POST",
      `/api/work-items/${item.id}/approval/request`,
      { request: "Review it", target: "coo" },
      headers,
      { loseResponse: true },
    )).rejects.toThrow("socket lost after commit");
    expect(activityBlocks(worker.id).find((block) => block.id === `todo:${item.id}`)).toMatchObject({
      payload: { action: "approval-requested" },
    });
    expect(companyEvents()).toHaveLength(1);

    const replay = await call(
      "POST",
      `/api/work-items/${item.id}/approval/request`,
      { request: "Review it", target: "coo" },
      toolHeaders(worker, "request_work_item_approval"),
    );
    expect(replay.status).toBe(200);
    expect(replay.body.activityReceiptId).toBe(`todo:${item.id}`);
    expect(activityBlocks(worker.id).filter((block) => block.id === `todo:${item.id}`)).toHaveLength(1);
    expect(companyEvents()).toHaveLength(1);
  });

  it("covers every canonical Todo mutation boundary with one typed event per durable write", async () => {
    const created = await call(
      "POST",
      "/api/work-items",
      { title: "Todo matrix", assignee: "worker" },
      toolHeaders(worker, "create_work_item"),
    );
    const item = created.body.workItem;
    const patched = await call("PATCH", `/api/work-items/${item.id}`, {
      title: "Todo matrix updated",
      expectedVersion: item.version,
      idempotencyKey: "metadata-matrix",
    });
    expect(patched.status).toBe(200);
    expect(patched.body).not.toHaveProperty("activityReceiptId");

    for (const status of ["executing", "in_review"]) {
      const moved = await call(
        "POST",
        `/api/work-items/${item.id}/status`,
        { status },
        toolHeaders(worker, "update_work_item"),
      );
      expect(moved.status).toBe(200);
      expect(moved.body.activityReceiptId).toBe(`todo:${item.id}`);
    }
    expect((await call(
      "POST",
      `/api/work-items/${item.id}/approval/request`,
      { request: "Review matrix", target: "coo" },
      toolHeaders(worker, "request_work_item_approval"),
    )).status).toBe(200);
    expect((await call(
      "POST",
      `/api/work-items/${item.id}/approval/escalate`,
      { reason: "Operator decision needed" },
      toolHeaders(coo, "escalate_work_item_approval"),
    )).status).toBe(200);
    expect((await call(
      "POST",
      `/api/work-items/${item.id}/approval`,
      { decision: "approve", note: "Approved" },
    )).status).toBe(200);

    const archiveCandidate = await call("POST", "/api/work-items", { title: "Archive matrix" }, toolHeaders(worker, "create_work_item"));
    expect((await call(
      "POST",
      `/api/work-items/${archiveCandidate.body.workItem.id}/archive`,
      {},
      toolHeaders(worker, "archive_work_item"),
    )).status).toBe(200);

    expect(companyEvents().map((entry) => entry.payload.action)).toEqual([
      "created",
      "metadata-updated",
      "status-transitioned",
      "status-transitioned",
      "approval-requested",
      "approval-escalated",
      "approval-decided",
      "created",
      "archived",
    ]);
    expect(companyEvents().every((entry) => entry.payload.entity === "todo")).toBe(true);
    expect(companyEvents().every((entry) => entry.payload.value?.id)).toBe(true);
  });

  it("stays silent on validation failures and read-only routes", async () => {
    expect((await call("POST", "/api/work-items", {}, toolHeaders(worker, "create_work_item"))).status).toBe(400);
    expect((await call("GET", "/api/work-items", undefined, toolHeaders(worker, "list_work_items"))).status).toBe(200);
    expect(companyEvents()).toEqual([]);
    expect(activityBlocks(worker.id)).toEqual([]);
  });

  it("keeps failed tool feedback receipt-free while retaining the durable failed run block", async () => {
    const invalidRunDefinition = {
      id: "failed-run-receipt",
      title: "Failed Run Receipt",
      nodes: [{ id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, trigger: { kind: "manual" } }],
      edges: [],
    };
    expect((await call("POST", "/api/workflow-definitions", invalidRunDefinition, toolHeaders(coo, "create_workflow"))).status).toBe(201);
    emitted = [];
    const failed = await call(
      "POST",
      "/api/workflow-definitions/failed-run-receipt/run",
      {},
      toolHeaders(coo, "start_workflow_run"),
    );
    expect(failed.status).toBe(422);
    expect(failed.body).not.toHaveProperty("activityReceiptId");
    expect(activityBlocks(coo.id)).toContainEqual(expect.objectContaining({
      type: "workflow-run",
      status: "error",
      payload: expect.objectContaining({ workflowId: "failed-run-receipt", action: "started" }),
    }));
    expect(companyEvents()).toHaveLength(1);
  });

  it("emits the same run event when an unbound custom event starts a durable run", async () => {
    expect((await call("POST", "/api/workflow-definitions", definition)).status).toBe(201);
    expect((await call("POST", "/api/workflow-triggers", {
      kind: "webhook",
      name: "unbound-event",
      event: "receipt.unbound",
      targetWorkflowId: "receipt-workflow",
    })).status).toBe(201);
    emitted = [];
    const fired = await call("POST", "/api/workflow-events", {
      event: "receipt.unbound",
      payload: { source: "test" },
      fireRef: "unbound-1",
    });
    expect(fired.status).toBe(202);
    expect(companyEvents()).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ entity: "workflow-run", action: "started", workflowId: "receipt-workflow" }),
    })]);
    expect(companyEvents()[0].payload).not.toHaveProperty("sessionId");
  });
});
