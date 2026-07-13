import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
let callbacks: typeof import("../../sessions/callbacks.js");
let coo: import("../../shared/types.js").Session;
let worker: import("../../shared/types.js").Session;
let emitted: Array<{ event: string; payload: any }> = [];
const processFetch = globalThis.fetch;
const pendingCallbackAttempts = new Set<{
  promise: Promise<Response>;
  reject: (reason: Error) => void;
}>();

function offlineCallbackFetch(): Promise<Response> {
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((_resolve, rejectAttempt) => {
    reject = rejectAttempt;
  });
  const attempt = { promise, reject };
  pendingCallbackAttempts.add(attempt);
  void promise.then(
    () => pendingCallbackAttempts.delete(attempt),
    () => pendingCallbackAttempts.delete(attempt),
  );
  return promise;
}

async function settleFailedCallbackAttempts(): Promise<void> {
  while (pendingCallbackAttempts.size > 0) {
    const attempts = [...pendingCallbackAttempts];
    for (const attempt of attempts) {
      attempt.reject(new Error("chat activity route test callback transport is offline"));
    }
    await Promise.allSettled(attempts.map((attempt) => attempt.promise));
    // Delivery failure persistence and retry scheduling happen after fetch
    // rejects. Let that outer async chain finish before clearing its timer or
    // allowing the next test to reset the database.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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

function toolHeaders(session: import("../../shared/types.js").Session, toolName: string, operationId: string = crypto.randomUUID()) {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: session.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(session.id),
    [ACTIVITY_OPERATION_HEADER]: operationId,
    [ACTIVITY_TOOL_HEADER]: toolName,
  };
}

function omitHeader(headers: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
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

function storedBlockBytes(sessionId: string, blockId: string): string | null {
  const rows = registry.initDb()
    .prepare("SELECT blocks FROM messages WHERE session_id = ? AND blocks IS NOT NULL ORDER BY rowid")
    .all(sessionId) as Array<{ blocks: string }>;
  return rows.find((row) => (JSON.parse(row.blocks) as Array<{ id: string }>).some((block) => block.id === blockId))?.blocks ?? null;
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
  callbacks = await import("../../sessions/callbacks.js");
  registry.initDb();
  globalThis.fetch = offlineCallbackFetch as typeof fetch;
  coo = registry.createSession({ engine: "codex", source: "web", sourceRef: "activity-coo", employee: "coo" });
  worker = registry.createSession({ engine: "codex", source: "web", sourceRef: "activity-worker", employee: "worker" });
});

afterEach(async () => {
  await settleFailedCallbackAttempts();
  expect(pendingCallbackAttempts.size, "callback delivery must settle before route-test teardown").toBe(0);
  const unsettled = registry.initDb().prepare(`
    SELECT COUNT(*) AS count
    FROM callback_deliveries
    WHERE status = 'pending' AND attempt_count > 0 AND last_error IS NULL
  `).get() as { count: number };
  expect(unsettled.count, "failed callback attempts must persist before retry reset").toBe(0);
  callbacks.__resetCallbackRetrySweepForTest();
});

afterAll(async () => {
  await settleFailedCallbackAttempts();
  callbacks.__resetCallbackRetrySweepForTest();
  globalThis.fetch = processFetch;
  const { stopScheduler } = await import("../../cron/scheduler.js");
  const { cleanupStagedPollExecutableArtifacts } = await import("../../workflows/poll-artifacts.js");
  stopScheduler();
  cleanupStagedPollExecutableArtifacts([], { cwd: home });
  registry.__closeDbForTest();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
});

beforeEach(() => {
  emitted = [];
  registry.initDb().exec("DELETE FROM work_item_events; DELETE FROM work_items; DELETE FROM messages;");
  fs.rmSync(path.join(evidence, "workflows"), { recursive: true, force: true });
  fs.rmSync(path.join(evidence, "reports"), { recursive: true, force: true });
  fs.mkdirSync(evidence, { recursive: true });
});

describe("persisted Todo and Workflow operation activity", () => {
  it("keeps historical Workflow-run Sessions byte-identical across signed Todo, definition, run, and trigger mutations", async () => {
    const historical = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "historical-workflow-run-activity",
      employee: "coo",
      workflowProvenance: {
        kind: "run",
        workflowId: "historical-receipt-workflow",
        workflowName: "Historical Receipt Workflow",
        runId: "historical-run",
        triggerSource: "manual",
      },
    });
    registry.insertMessage(historical.id, "user", "Historical request");
    registry.insertMessage(historical.id, "assistant", "Historical response");
    const database = registry.initDb();
    const snapshot = () => ({
      session: database.prepare("SELECT * FROM sessions WHERE id = ?").get(historical.id),
      messages: database.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid").all(historical.id),
    });
    const before = snapshot();

    const createdTodo = await call(
      "POST",
      "/api/work-items",
      { title: "Historical caller Todo" },
      toolHeaders(historical, "create_work_item"),
    );
    expect(createdTodo.status).toBe(201);
    expect(createdTodo.body).not.toHaveProperty("activityReceiptId");

    const legacyDefinition = { ...definition, id: "historical-receipt-workflow" };
    const createdDefinition = await call(
      "POST",
      "/api/workflow-definitions",
      legacyDefinition,
      toolHeaders(historical, "create_workflow"),
    );
    expect(createdDefinition.status).toBe(201);
    expect(createdDefinition.body).not.toHaveProperty("activityReceiptId");

    const started = await call(
      "POST",
      "/api/workflow-definitions/historical-receipt-workflow/run",
      { idempotencyKey: "historical-run-start" },
      toolHeaders(historical, "start_workflow_run"),
    );
    expect(started.status).toBe(201);
    expect(started.body).not.toHaveProperty("activityReceiptId");

    const createdTrigger = await call(
      "POST",
      "/api/workflow-triggers",
      {
        kind: "webhook",
        name: "historical-receipt-trigger",
        event: "historical.receipt.ready",
        targetWorkflowId: "historical-receipt-workflow",
      },
      toolHeaders(historical, "create_trigger"),
    );
    expect(createdTrigger.status).toBe(201);
    expect(createdTrigger.body).not.toHaveProperty("activityReceiptId");

    expect(snapshot()).toEqual(before);
    expect(emitted.filter((entry) => entry.event === "session:delta" && entry.payload.sessionId === historical.id)).toEqual([]);
    expect(companyEvents()).toHaveLength(4);
    expect(companyEvents().every((entry) => entry.payload.sessionId === undefined)).toBe(true);
  });

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

    const mismatched = await call("POST", "/api/work-items", { title: "Mismatched capability" }, {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: worker.id,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(coo.id),
      [ACTIVITY_OPERATION_HEADER]: crypto.randomUUID(),
      [ACTIVITY_TOOL_HEADER]: "create_work_item",
    });
    expect(mismatched.status).toBe(403);
    expect(companyEvents()).toEqual([]);
    expect(activityBlocks(worker.id)).toEqual([]);
  });

  it("suppresses receipt projection for incomplete, malformed, or route-mismatched correlation tuples", async () => {
    const missingTool = await call(
      "POST",
      "/api/work-items",
      { title: "Missing tool tuple" },
      omitHeader(toolHeaders(worker, "create_work_item"), ACTIVITY_TOOL_HEADER),
    );
    expect(missingTool.status).toBe(201);
    expect(missingTool.body).not.toHaveProperty("activityReceiptId");

    const wrongTool = await call(
      "POST",
      "/api/work-items",
      { title: "Wrong tool tuple" },
      toolHeaders(worker, "delete_trigger"),
    );
    expect(wrongTool.status).toBe(201);
    expect(wrongTool.body).not.toHaveProperty("activityReceiptId");

    const missingOperation = await call(
      "POST",
      "/api/workflow-definitions",
      { ...definition, id: "missing-operation-workflow" },
      omitHeader(toolHeaders(coo, "create_workflow"), ACTIVITY_OPERATION_HEADER),
    );
    expect(missingOperation.status).toBe(201);
    expect(missingOperation.body).not.toHaveProperty("activityReceiptId");

    const malformedOperation = await call(
      "POST",
      "/api/workflow-definitions/missing-operation-workflow/run",
      { idempotencyKey: "malformed-operation-run" },
      toolHeaders(coo, "start_workflow_run", "not-a-uuid"),
    );
    expect(malformedOperation.status).toBe(201);
    expect(malformedOperation.body).not.toHaveProperty("activityReceiptId");

    const missingMarker = await call(
      "POST",
      "/api/workflow-triggers",
      {
        kind: "webhook",
        name: "missing-marker-trigger",
        event: "missing.marker",
        targetWorkflowId: "missing-operation-workflow",
      },
      omitHeader(toolHeaders(coo, "create_trigger"), TOOL_CALL_HEADER),
    );
    expect(missingMarker.status).toBe(201);
    expect(missingMarker.body).not.toHaveProperty("activityReceiptId");

    expect(activityBlocks(worker.id)).toEqual([]);
    expect(activityBlocks(coo.id)).toEqual([
      expect.objectContaining({
        type: "workflow-run",
        payload: expect.not.objectContaining({ activityReceipt: expect.anything() }),
      }),
    ]);
    expect(companyEvents()).toHaveLength(5);
    expect(companyEvents().every((entry) => entry.payload.sessionId === undefined)).toBe(true);
  });

  it("projects receipts only for valid exact Todo, definition, run, and trigger tuples", async () => {
    const todo = await call(
      "POST",
      "/api/work-items",
      { title: "Exact Todo tuple" },
      toolHeaders(worker, "create_work_item"),
    );
    expect(todo.body.activityReceiptId).toBe(`todo:${todo.body.workItem.id}`);

    const exactDefinition = { ...definition, id: "exact-tuple-workflow" };
    const workflow = await call(
      "POST",
      "/api/workflow-definitions",
      exactDefinition,
      toolHeaders(coo, "create_workflow"),
    );
    expect(workflow.body.activityReceiptId).toBe("workflow-definition:exact-tuple-workflow");

    const run = await call(
      "POST",
      "/api/workflow-definitions/exact-tuple-workflow/run",
      { idempotencyKey: "exact-tuple-run" },
      toolHeaders(coo, "start_workflow_run"),
    );
    expect(run.body.activityReceiptId).toMatch(/^workflow-run:exact-tuple-workflow:/);

    const trigger = await call(
      "POST",
      "/api/workflow-triggers",
      {
        kind: "webhook",
        name: "exact-tuple-trigger",
        event: "exact.tuple",
        targetWorkflowId: "exact-tuple-workflow",
      },
      toolHeaders(coo, "create_trigger"),
    );
    expect(trigger.body.activityReceiptId).toBe("workflow-definition:exact-tuple-workflow");
  });

  it.each([76, 77, 128])("keeps %i-character Workflow identity through create, update, trigger, and durable reload", async (length) => {
    const workflowId = `w${"a".repeat(length - 1)}`;
    const longDefinition = { ...definition, id: workflowId, title: `Workflow ${length}` };
    const created = await call(
      "POST",
      "/api/workflow-definitions",
      longDefinition,
      toolHeaders(coo, "create_workflow"),
    );
    expect(created.status).toBe(201);
    const receiptId = created.body.activityReceiptId as string;
    expect(receiptId).toBeTypeOf("string");
    expect(receiptId.length).toBeLessThanOrEqual(96);
    if (length === 76) expect(receiptId).toBe(`workflow-definition:${workflowId}`);

    const updated = await call(
      "PUT",
      `/api/workflow-definitions/${encodeURIComponent(workflowId)}`,
      { title: `Workflow ${length} updated`, expectedVersion: 1 },
      toolHeaders(coo, "update_workflow"),
    );
    expect(updated.status).toBe(200);
    expect(updated.body.activityReceiptId).toBe(receiptId);

    const trigger = await call(
      "POST",
      "/api/workflow-triggers",
      {
        kind: "webhook",
        name: `long-workflow-${length}`,
        event: `long.workflow.${length}`,
        targetWorkflowId: workflowId,
      },
      toolHeaders(coo, "create_trigger"),
    );
    expect(trigger.status).toBe(201);
    expect(trigger.body.activityReceiptId).toBe(receiptId);

    const reloaded = registry.getMessages(coo.id)
      .flatMap((message) => message.blocks ?? [])
      .find((block) => block.id === receiptId);
    expect(reloaded).toMatchObject({
      id: receiptId,
      type: "workflow-definition",
      payload: {
        workflowId,
        action: "trigger-created",
        openPath: `/workflow/${encodeURIComponent(workflowId)}`,
      },
    });
    expect(activityBlocks(coo.id).filter((block) => block.id === receiptId)).toHaveLength(1);
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
    expect(decided.body).not.toHaveProperty("activityReceiptId");

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

  it("treats only exact equal activity as idempotent and refuses stale or unsequenced equal overwrites", async () => {
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
      payload: { action: "assigned" },
    });

    const persisted = activityBlocks(worker.id).find((block) => block.id === `todo:${item.id}`)!;
    const beforeReplay = storedBlockBytes(worker.id, `todo:${item.id}`);
    registry.applyBlockEnvelope(worker.id, { op: "put", block: persisted }, "assigned");
    expect(storedBlockBytes(worker.id, `todo:${item.id}`)).toBe(beforeReplay);
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

    const blockBytes = storedBlockBytes(worker.id, `todo:${item.id}`);

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
    expect(storedBlockBytes(worker.id, `todo:${item.id}`)).toBe(blockBytes);
  });

  it("keeps Todo status, assignment, and approval-escalation no-ops receipt-stable and mutation-silent", async () => {
    const created = await call(
      "POST",
      "/api/work-items",
      { title: "Todo no-op controls", assignee: "worker" },
      toolHeaders(worker, "create_work_item"),
    );
    const todoId = created.body.workItem.id as string;
    const blockId = `todo:${todoId}`;

    const assigned = await call(
      "POST",
      `/api/work-items/${todoId}/assign`,
      { assignee: "worker" },
      toolHeaders(coo, "assign_work_item"),
    );
    expect(assigned.status).toBe(200);
    const assignmentVersion = assigned.body.workItem.version;
    const assignmentBytes = storedBlockBytes(coo.id, blockId);
    const assignmentEvents = companyEvents().length;
    const assignmentReplay = await call(
      "POST",
      `/api/work-items/${todoId}/assign`,
      { assignee: "worker" },
      toolHeaders(coo, "assign_work_item"),
    );
    expect(assignmentReplay.body).toMatchObject({ activityReceiptId: blockId, workItem: { version: assignmentVersion } });
    expect(storedBlockBytes(coo.id, blockId)).toBe(assignmentBytes);
    expect(companyEvents()).toHaveLength(assignmentEvents);

    const transitioned = await call(
      "POST",
      `/api/work-items/${todoId}/status`,
      { status: "executing" },
      toolHeaders(worker, "update_work_item"),
    );
    const statusVersion = transitioned.body.workItem.version;
    const statusBytes = storedBlockBytes(worker.id, blockId);
    const statusEvents = companyEvents().length;
    const statusReplay = await call(
      "POST",
      `/api/work-items/${todoId}/status`,
      { status: "executing" },
      toolHeaders(worker, "update_work_item"),
    );
    expect(statusReplay.body).toMatchObject({ activityReceiptId: blockId, workItem: { version: statusVersion } });
    expect(storedBlockBytes(worker.id, blockId)).toBe(statusBytes);
    expect(companyEvents()).toHaveLength(statusEvents);

    await call(
      "POST",
      `/api/work-items/${todoId}/approval/request`,
      { request: "Review no-op controls", target: "coo" },
      toolHeaders(worker, "request_work_item_approval"),
    );
    const escalated = await call(
      "POST",
      `/api/work-items/${todoId}/approval/escalate`,
      { reason: "Operator review" },
      toolHeaders(coo, "escalate_work_item_approval"),
    );
    const escalationVersion = escalated.body.workItem.version;
    const escalationBytes = storedBlockBytes(coo.id, blockId);
    const escalationEvents = companyEvents().length;
    const escalationReplay = await call(
      "POST",
      `/api/work-items/${todoId}/approval/escalate`,
      { reason: "Operator review" },
      toolHeaders(coo, "escalate_work_item_approval"),
    );
    expect(escalationReplay.body).toMatchObject({ activityReceiptId: blockId, workItem: { version: escalationVersion } });
    expect(storedBlockBytes(coo.id, blockId)).toBe(escalationBytes);
    expect(companyEvents()).toHaveLength(escalationEvents);
  });

  it("keeps run cancellation, gate escalation, and trigger escalation no-ops receipt-free and mutation-silent", async () => {
    expect((await call("POST", "/api/workflow-definitions", definition, toolHeaders(coo, "create_workflow"))).status).toBe(201);

    const gateRun = await call(
      "POST",
      "/api/workflow-definitions/receipt-workflow/run",
      { idempotencyKey: "noop-gate-run" },
      toolHeaders(coo, "start_workflow_run"),
    );
    const gateReceipt = gateRun.body.activityReceiptId as string;
    const gateEscalated = await call(
      "POST",
      `/api/workflow-definitions/receipt-workflow/runs/${gateRun.body.runId}/gate-approval/escalate`,
      {},
      toolHeaders(coo, "escalate_workflow_gate"),
    );
    const gateRevision = gateEscalated.body.revision;
    const gateBytes = storedBlockBytes(coo.id, gateReceipt);
    const gateEvents = companyEvents().length;
    const gateReplay = await call(
      "POST",
      `/api/workflow-definitions/receipt-workflow/runs/${gateRun.body.runId}/gate-approval/escalate`,
      {},
      toolHeaders(coo, "escalate_workflow_gate"),
    );
    expect(gateReplay.body).not.toHaveProperty("activityReceiptId");
    expect(gateReplay.body.revision).toBe(gateRevision);
    expect(storedBlockBytes(coo.id, gateReceipt)).toBe(gateBytes);
    expect(companyEvents()).toHaveLength(gateEvents);

    const cancellable = await call(
      "POST",
      "/api/workflow-definitions/receipt-workflow/run",
      { idempotencyKey: "noop-cancel-run" },
      toolHeaders(coo, "start_workflow_run"),
    );
    const cancelReceipt = cancellable.body.activityReceiptId as string;
    const cancelled = await call(
      "POST",
      `/api/workflow-definitions/receipt-workflow/runs/${cancellable.body.runId}/cancel`,
      { reason: "No longer needed" },
      toolHeaders(coo, "cancel_workflow_run"),
    );
    const cancellationRevision = cancelled.body.revision;
    const cancellationBytes = storedBlockBytes(coo.id, cancelReceipt);
    const cancellationEvents = companyEvents().length;
    const cancellationReplay = await call(
      "POST",
      `/api/workflow-definitions/receipt-workflow/runs/${cancellable.body.runId}/cancel`,
      { reason: "No longer needed" },
      toolHeaders(coo, "cancel_workflow_run"),
    );
    expect(cancellationReplay.body).not.toHaveProperty("activityReceiptId");
    expect(cancellationReplay.body.revision).toBe(cancellationRevision);
    expect(storedBlockBytes(coo.id, cancelReceipt)).toBe(cancellationBytes);
    expect(companyEvents()).toHaveLength(cancellationEvents);

    const pollScript = path.join(evidence, "noop-poll.sh");
    fs.writeFileSync(pollScript, "#!/bin/sh\nprintf '%s' '{}'\n", "utf8");
    fs.chmodSync(pollScript, 0o700);
    expect((await call("POST", "/api/workflow-triggers", {
      kind: "poll",
      name: "noop-poll",
      event: "noop.poll",
      targetWorkflowId: "receipt-workflow",
      command: pollScript,
      intervalSeconds: 60,
    }, toolHeaders(coo, "create_trigger"))).status).toBe(201);
    const triggerEscalated = await call(
      "POST",
      "/api/workflow-triggers/noop-poll/activation-approval/escalate",
      {},
      toolHeaders(coo, "escalate_poll_activation"),
    );
    const triggerBytes = storedBlockBytes(coo.id, "workflow-definition:receipt-workflow");
    const triggerEvents = companyEvents().length;
    const triggerReplay = await call(
      "POST",
      "/api/workflow-triggers/noop-poll/activation-approval/escalate",
      {},
      toolHeaders(coo, "escalate_poll_activation"),
    );
    expect(triggerEscalated.status).toBe(200);
    expect(triggerReplay.body).not.toHaveProperty("activityReceiptId");
    expect(triggerReplay.body.trigger).toEqual(triggerEscalated.body.trigger);
    expect(storedBlockBytes(coo.id, "workflow-definition:receipt-workflow")).toBe(triggerBytes);
    expect(companyEvents()).toHaveLength(triggerEvents);
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
