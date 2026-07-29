import { Readable } from "node:stream";
import http from "node:http";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletion, WorkflowAttemptCompletionListener } from "../../shared/types.js";
import { openWorkflowDatabase } from "../../workflows/repository-migrations.js";
import { WorkflowRepository, WorkflowRepositoryError } from "../../workflows/repository.js";
import { WorkflowService, WorkflowServiceError } from "../../workflows/service.js";
import type { WorkflowSessionExecutor } from "../../workflows/session-executor.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { createSession } from "../../sessions/registry.js";
import { handleApiRequest, type ApiContext } from "../api.js";
import { readJsonBody } from "../http-helpers.js";

function request(method: string, url: string, body?: unknown, authorized = true, contentType = "application/json",
  extraHeaders: Record<string, string> = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url,
    headers: { host: "localhost", ...(authorized ? { authorization: "Bearer test-token" } : {}),
      "content-type": contentType, ...extraHeaders },
  });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

function rawRequest(method: string, url: string, raw: string) {
  const req = Readable.from([Buffer.from(raw)]);
  Object.assign(req, { method, url, headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json" } });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

function response() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    setHeader: vi.fn(),
    writeHead(code: number) { status = code; return this; },
    write(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body: chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    : undefined }) };
}

function workflowToolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

describe("Workflow v2 canonical API", () => {
  it("creates and lists through the injected WorkflowService", async () => {
    const created = { id: "release-flow", title: "Release flow", revision: 1, enabled: false };
    const service = {
      createDefinition: vi.fn(() => created),
      listDefinitions: vi.fn(() => ({ items: [created], nextCursor: null })),
    };
    const context = {
      gatewayAuthToken: "test-token",
      getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(),
      sessionManager: { getQueue: () => ({}) },
      workflowService: service,
      emit: vi.fn(),
      startTime: Date.now(),
    } as unknown as ApiContext;

    const post = response();
    await handleApiRequest(request("POST", "/api/workflows", { id: "release-flow", title: "Release flow" }), post.res, context);
    expect(post.read()).toMatchObject({ status: 201, body: created });
    expect(service.createDefinition).toHaveBeenCalledWith({ id: "release-flow", title: "Release flow" });

    const get = response();
    await handleApiRequest(request("GET", "/api/workflows?limit=10"), get.res, context);
    expect(get.read()).toEqual({ status: 200, body: { items: [created], nextCursor: null } });
  });

  it("routes the complete Task13 CRUD/run/transcript matrix", async () => {
    const result = { id: "release-flow", revision: 2 };
    const service = {
      getDefinition: vi.fn(() => result), saveDefinition: vi.fn(() => result), duplicateDefinition: vi.fn(() => result),
      retireDefinition: vi.fn(() => result), setEnabled: vi.fn(() => result), startManual: vi.fn(async () => result),
      listRuns: vi.fn(() => ({ items: [result], nextCursor: null })), getRun: vi.fn(() => result),
      cancelRun: vi.fn(async () => result), rerun: vi.fn(async () => result), getAttemptTranscript: vi.fn(() => []),
      decideApproval: vi.fn(async () => result), retryNode: vi.fn(async () => result),
      fireEvent: vi.fn(async () => [result]), listDefinitions: vi.fn(), createDefinition: vi.fn(),
    };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const cases: Array<[string, string, unknown, number]> = [
      ["GET", "/api/workflows/release-flow", undefined, 200],
      ["PUT", "/api/workflows/release-flow", { definition: { schemaVersion: 1 }, expectedRevision: 1 }, 200],
      ["POST", "/api/workflows/release-flow/duplicate", { id: "copy-flow", title: "Copy" }, 201],
      ["POST", "/api/workflows/release-flow/retire", { expectedRevision: 1 }, 200],
      ["POST", "/api/workflows/release-flow/enable", { expectedRevision: 1 }, 200],
      ["POST", "/api/workflows/release-flow/disable", { expectedRevision: 1 }, 200],
      ["POST", "/api/workflows/release-flow/runs", { input: {} }, 201],
      ["GET", "/api/workflows/release-flow/runs?limit=10", undefined, 200],
      ["GET", "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111", undefined, 200],
      ["POST", "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/cancel", { reason: "superseded" }, 200],
      ["POST", "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/rerun", { definition: "original", idempotencyKey: "again-1" }, 201],
      ["POST", "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/nodes/review/approval",
        { decision: "approve", reason: "Reviewed", expectedRevision: 4 }, 200],
      ["POST", "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/nodes/write/retry",
        { idempotencyKey: "retry-1" }, 200],
      ["GET", "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/nodes/write/attempts/1/transcript", undefined, 200],
    ];
    for (const [method, url, payload, status] of cases) {
      const capture = response(); await handleApiRequest(request(method, url, payload), capture.res, context);
      expect(capture.read().status, `${method} ${url}`).toBe(status);
    }
    expect(service.getAttemptTranscript).toHaveBeenCalledWith({ workflowId: "release-flow",
      runId: "run_11111111-1111-4111-8111-111111111111", nodeId: "write", attempt: 1 });
    expect(service.decideApproval).toHaveBeenCalledWith({ workflowId: "release-flow",
      runId: "run_11111111-1111-4111-8111-111111111111", nodeId: "review", decision: "approve",
      reason: "Reviewed", expectedRevision: 4, decidedBy: "operator" });
    expect(service.retryNode).toHaveBeenCalledWith({ workflowId: "release-flow",
      runId: "run_11111111-1111-4111-8111-111111111111", nodeId: "write", idempotencyKey: "retry-1" });
  });

  it("binds a manual run to an existing Todo and leaves unbound runs unbound", async () => {
    const startManual = vi.fn(async () => ({ id: "run-1" }));
    const context = { gatewayAuthToken: "test-token", workflowService: { startManual }, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;

    const bound = response();
    await handleApiRequest(request("POST", "/api/workflows/release-flow/runs", { input: {}, todoId: "JIN-42" }), bound.res, context);
    expect(bound.read().status).toBe(201);
    expect(startManual).toHaveBeenCalledWith({ workflowId: "release-flow", input: {}, todoId: "JIN-42" });

    const unbound = response();
    await handleApiRequest(request("POST", "/api/workflows/release-flow/runs", { input: {} }), unbound.res, context);
    expect(startManual).toHaveBeenLastCalledWith({ workflowId: "release-flow", input: {} });
    expect(unbound.read().status).toBe(201);
  });

  it("serializes reminder ladder state on every run-detail attempt", async () => {
    const detail = {
      id: "run_11111111-1111-4111-8111-111111111111",
      workflowId: "release-flow",
      attempts: [{
        runId: "run_11111111-1111-4111-8111-111111111111",
        nodeId: "write",
        attempt: 1,
        status: "running",
        promptText: "Write the notes.\n\n---\nContract block.",
        remindersSent: 2,
        nextReminderAt: "2026-07-23T12:30:00.000Z",
        extensions: 1,
        lastExtensionReason: "Waiting on review",
        pendingOutputError: "Required output field \"result\" is missing.",
      }],
    };
    const service = { getRun: vi.fn(() => detail) };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const capture = response();

    await handleApiRequest(request("GET",
      "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111"), capture.res, context);

    expect(capture.read()).toEqual({ status: 200, body: detail });
  });

  it("authenticates retry and maps its authority, identity, conflict, and validation errors", async () => {
    const retryNode = vi.fn();
    const context = { gatewayAuthToken: "test-token", workflowService: { retryNode }, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const route = "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/nodes/write/retry";
    const unauthorized = response(); await handleApiRequest(request("POST", route, { idempotencyKey: "retry-1" }, false), unauthorized.res, context);
    expect(unauthorized.read().status).toBe(401); expect(retryNode).not.toHaveBeenCalled();
    for (const [error, status] of [
      [new WorkflowServiceError("forbidden", "Retry forbidden."), 403],
      [new WorkflowRepositoryError("not-found", "Node missing."), 404],
      [new WorkflowServiceError("conflict", "Node active."), 409],
      [new WorkflowRepositoryError("bad-input", "Retry exhausted."), 422],
    ] as const) {
      retryNode.mockRejectedValueOnce(error); const capture = response();
      await handleApiRequest(request("POST", route, { idempotencyKey: "retry-1" }), capture.res, context);
      expect(capture.read()).toMatchObject({ status, body: { message: error.message } });
    }
  });

  it("maps executable validation failures to a stable 422 issue envelope", async () => {
    const issues = [{ code: "undeclared-input", message: "Input binding references an undeclared Workflow input.",
      nodeId: "work", path: "nodes.1.config.employee" }];
    const setEnabled = vi.fn(() => {
      throw new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", issues);
    });
    const context = { gatewayAuthToken: "test-token", workflowService: { setEnabled }, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const capture = response();

    await handleApiRequest(request("POST", "/api/workflows/invalid-field/enable", { expectedRevision: 2 }), capture.res, context);

    expect(capture.read()).toEqual({ status: 422, body: {
      code: "invalid-definition", message: "Workflow definition is invalid.", issues,
    } });
    expect(setEnabled).toHaveBeenCalledWith({ id: "invalid-field", enabled: true, expectedRevision: 2 });
  });

  it("carries repository schema issues in the error envelope too", async () => {
    const issues = [{ code: "schema", message: "Node name must contain at least 1 character.", path: "nodes.0.name" }];
    const error = new WorkflowRepositoryError("bad-input", "Workflow definition is invalid.", issues);
    const service = { saveDefinition: () => { throw error; } };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const capture = response();

    await handleApiRequest(request("PUT", "/api/workflows/broken-flow", { definition: { id: "broken-flow" }, expectedRevision: 1 }), capture.res, context);

    expect(capture.read()).toEqual({ status: 422, body: {
      code: "bad-input", message: "Workflow definition is invalid.", issues,
    } });
  });

  it("rejects approval actor spoofing before the service and maps approval authority/conflict errors", async () => {
    const decideApproval = vi.fn();
    const context = { gatewayAuthToken: "test-token", workflowService: { decideApproval }, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const spoof = response();
    await handleApiRequest(request("POST", "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/nodes/review/approval",
      { decision: "approve", decidedBy: "spoofed", expectedRevision: 1 }), spoof.res, context);
    expect(spoof.read()).toEqual({ status: 422, body: { code: "bad-input", message: "Workflow request is invalid." } });
    expect(decideApproval).not.toHaveBeenCalled();

    for (const [code, status] of [["forbidden", 403], ["conflict", 409]] as const) {
      decideApproval.mockRejectedValueOnce(new WorkflowServiceError(code, `${code} decision`));
      const capture = response();
      await handleApiRequest(request("POST", "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/nodes/review/approval",
        { decision: "reject", expectedRevision: 1 }), capture.res, context);
      expect(capture.read()).toEqual({ status, body: { code, message: `${code} decision` } });
    }
  });

  it.each([
    ["not-found", 404], ["id-conflict", 409], ["revision-conflict", 409],
    ["idempotency-conflict", 409], ["bad-input", 422], ["retired", 422], ["corrupt-record", 500],
  ] as const)("maps %s without losing the error envelope", async (code, status) => {
    const service = { createDefinition: () => { throw new WorkflowRepositoryError(code, "mapped failure"); } };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const capture = response(); await handleApiRequest(request("POST", "/api/workflows", { id: "flow", title: "Flow" }), capture.res, context);
    expect(capture.read()).toEqual({ status, body: { code, message: "mapped failure" } });
  });

  it("authenticates writes before service lookup", async () => {
    const service = { fireEvent: vi.fn() };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const capture = response();
    await handleApiRequest(request("POST", "/api/workflows/events/build.finished", { fireId: "build-1", payload: {} }, false), capture.res, context);
    expect(capture.read()).toEqual({ status: 401, body: { code: "unauthorized", message: "Workflow authentication required." } });
    expect(service.fireEvent).not.toHaveBeenCalled();
  });

  it("rejects a spoofed tool caller before Workflow service lookup or body consumption", async () => {
    const serviceLookup = vi.fn();
    const context = { gatewayAuthToken: "test-token", getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    Object.defineProperty(context, "workflowService", {
      get() { serviceLookup(); return { createDefinition: vi.fn() }; },
    });
    const req = request("POST", "/api/workflows", { id: "blocked-flow", title: "Blocked" }, true, "application/json", {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: "spoofed-session",
      [CALLER_SESSION_CAPABILITY_HEADER]: "spoofed-capability",
    });
    const capture = response();

    await handleApiRequest(req, capture.res, context);

    expect(capture.read()).toMatchObject({ status: 403, body: { error: expect.stringMatching(/caller identity unavailable/i) } });
    expect(serviceLookup).not.toHaveBeenCalled();
    expect(req.readableEnded).toBe(false);
  });

  it("keeps bearer-authenticated operator creation and Event firing reachable", async () => {
    const created = { id: "operator-flow", revision: 1 };
    const fired = [{ id: "run-1", status: "running" }];
    const service = { createDefinition: vi.fn(() => created), fireEvent: vi.fn(async () => fired) };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const create = response();
    await handleApiRequest(request("POST", "/api/workflows", { id: "operator-flow", title: "Operator" }), create.res, context);
    const event = response();
    await handleApiRequest(request("POST", "/api/workflows/events/build.finished", { fireId: "build-1", payload: {} }), event.res, context);

    expect(create.read()).toEqual({ status: 201, body: created });
    expect(event.read()).toEqual({ status: 202, body: fired });
    expect(service.createDefinition).toHaveBeenCalledOnce();
    expect(service.fireEvent).toHaveBeenCalledOnce();
  });

  it("returns the typed 422 envelope for malformed Workflow JSON", async () => {
    const service = { createDefinition: vi.fn() };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const capture = response();

    await handleApiRequest(rawRequest("POST", "/api/workflows", "{"), capture.res, context);

    expect(capture.read()).toEqual({ status: 422, body: { code: "bad-input", message: "Request body must be canonical JSON." } });
    expect(service.createDefinition).not.toHaveBeenCalled();
  });

  it("keeps the shared malformed-JSON default at its existing 400 envelope", async () => {
    const capture = response();
    const result = await readJsonBody(rawRequest("POST", "/api/other", "{"), capture.res);

    expect(result).toEqual({ ok: false });
    expect(capture.read()).toEqual({ status: 400, body: { error: "Invalid JSON in request body" } });
  });

  it("delivers a structured 413 for an oversized Workflow body over a real HTTP socket", async () => {
    const service = { createDefinition: vi.fn() };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const server = http.createServer((req, res) => { void handleApiRequest(req, res, context); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ id: "oversized-flow", title: "Oversized", description: "x".repeat(257 * 1024) }),
      });
      expect(result.status).toBe(413);
      await expect(result.json()).resolves.toEqual({ code: "payload-too-large", message: "Request body is too large." });
      expect(service.createDefinition).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects executable Event content types before dispatch", async () => {
    const service = { fireEvent: vi.fn() };
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    const capture = response();
    await handleApiRequest(request("POST", "/api/workflows/events/build.finished",
      { fireId: "build-1", payload: {} }, true, "text/javascript"), capture.res, context);
    expect(capture.read()).toEqual({ status: 422, body: { code: "bad-input", message: "Workflow requests require JSON content." } });
    expect(service.fireEvent).not.toHaveBeenCalled();
  });

  it("reserves /events for Event firing and rejects it as a canonical Workflow identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-events-route-"));
    const database = openWorkflowDatabase(path.join(root, "workflows.db"));
    const repository = new WorkflowRepository(database);
    const executor = { subscribe: () => () => undefined, startAttempt: vi.fn(), stopAttempt: vi.fn(), readTerminalCompletion: () => null } as unknown as WorkflowSessionExecutor;
    const service = new WorkflowService({ repository, executor, employees: () => new Map(), models: () => ({}) });
    const duplicate = vi.spyOn(service, "duplicateDefinition");
    const fire = vi.spyOn(service, "fireEvent");
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    try {
      const create = response();
      await handleApiRequest(request("POST", "/api/workflows", { id: "events", title: "Reserved" }), create.res, context);
      expect(create.read()).toEqual({ status: 422, body: { code: "bad-input", message: "Workflow definition is invalid.",
        issues: [expect.objectContaining({ code: "schema", path: "id" })] } });

      const event = response();
      await handleApiRequest(request("POST", "/api/workflows/events/duplicate", { fireId: "event-1", payload: {} }), event.res, context);
      expect(event.read()).toEqual({ status: 202, body: [] });
      expect(fire).toHaveBeenCalledWith({ eventName: "duplicate", fireId: "event-1", payload: {} });
      expect(duplicate).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("External script -> Event -> Employee -> End", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-event-api-"));
    const database = openWorkflowDatabase(path.join(root, "workflows.db"));
    const repository = new WorkflowRepository(database);
    const employee: Employee = { name: "worker", displayName: "Worker", department: "platform", rank: "employee",
      engine: "test-engine", model: "model-a", effortLevel: "high", persona: "Executes work." };
    const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "model-a", effortMechanism: "codex-config",
      models: [{ id: "model-a", label: "Model A", supportsEffort: true, effortLevels: ["high"] }] } };
    let listener: WorkflowAttemptCompletionListener | undefined; const commands: WorkflowAttemptCommand[] = []; const stopped: string[] = [];
    const definitionNotifications: Array<{ workflowId: string; revision: number }> = [];
    const runNotifications: Array<{ workflowId: string; runId: string }> = [];
    const executor = { subscribe(value: WorkflowAttemptCompletionListener) { listener = value; return () => { listener = undefined; }; },
      async startAttempt(command: WorkflowAttemptCommand) { commands.push(command); return { sessionId: `session-${commands.length}` }; },
      async stopAttempt(input: { sessionId: string }) { stopped.push(input.sessionId); }, readTerminalCompletion() { return null; } } as unknown as WorkflowSessionExecutor;
    const service = new WorkflowService({ repository, executor, employees: () => new Map([[employee.name, employee]]), models: () => models,
      readTranscript: () => [{ id: "message-1", role: "assistant", content: "Done.", timestamp: 1_774_051_200_000 }],
      onDefinitionChange: (change) => {
        expect(repository.getDefinition(change.workflowId)?.revision).toBe(change.revision);
        definitionNotifications.push(change);
      },
      onChange: (change) => {
        expect(repository.getRun(change.workflowId, change.runId)).not.toBeNull();
        runNotifications.push(change);
      } });
    try {
      const created = service.createDefinition({ id: "event-flow", title: "Event flow" });
      const saved = service.saveDefinition({ ...created, nodes: [
        { id: "start", type: "trigger", name: "Start", config: { kind: "event", eventName: "build.finished" } },
        { id: "write", type: "employee", name: "Write", config: { employee: { source: "fixed", value: "worker" }, prompt: "Report status.",
          output: { fields: { result: { type: "string", required: true } }, allowAdditionalFields: false } } },
        { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
      ], edges: [
        { id: "start-write", from: { nodeId: "start", port: "success" }, to: { nodeId: "write", port: "input" } },
        { id: "write-finish", from: { nodeId: "write", port: "success" }, to: { nodeId: "finish", port: "input" } },
      ] }, created.revision);
      service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision });
      const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
        connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
      const first = response();
      await handleApiRequest(request("POST", "/api/workflows/events/build.finished", { fireId: "build-123", payload: { status: "passed" } }), first.res, context);
      const started = first.read().body as Array<{ id: string }>;
      expect(first.read().status).toBe(202); expect(commands).toHaveLength(1);
      await listener!({ sessionId: "session-1", owner: commands[0]!.owner, turn: 1, terminalVersion: 1, outcome: "succeeded",
        finalText: "Done.\n```jinn-output\n{\"result\":\"ok\"}\n```", completedAt: new Date().toISOString() } as WorkflowAttemptCompletion);
      expect(service.getRun("event-flow", started[0]!.id)?.status).toBe("completed");
      const replay = response();
      await handleApiRequest(request("POST", "/api/workflows/events/build.finished", { fireId: "build-123", payload: { status: "passed" } }), replay.res, context);
      expect((replay.read().body as Array<{ id: string }>)[0]!.id).toBe(started[0]!.id); expect(commands).toHaveLength(1);
      const transcript = response();
      await handleApiRequest(request("GET", `/api/workflows/event-flow/runs/${started[0]!.id}/nodes/write/attempts/1/transcript`), transcript.res, context);
      expect(transcript.read().body).toEqual([{ id: "message-1", role: "assistant", content: "Done.", timestamp: 1_774_051_200_000 }]);

      const current = service.getDefinition("event-flow")!;
      const revised = service.saveDefinition({ ...current, title: "Event flow revised" }, current.revision);
      const original = response();
      await handleApiRequest(request("POST", `/api/workflows/event-flow/runs/${started[0]!.id}/rerun`,
        { definition: "original", idempotencyKey: "rerun-original" }), original.res, context);
      const originalRun = original.read().body as { id: string; definitionRevision: number };
      expect(originalRun.definitionRevision).toBe(current.revision); expect(commands).toHaveLength(2);
      const cancelled = response();
      await handleApiRequest(request("POST", `/api/workflows/event-flow/runs/${originalRun.id}/cancel`, { reason: "superseded" }), cancelled.res, context);
      expect(cancelled.read().body).toMatchObject({ status: "cancelled" }); expect(stopped).toEqual(["session-2"]);

      const latest = response();
      await handleApiRequest(request("POST", `/api/workflows/event-flow/runs/${started[0]!.id}/rerun`,
        { definition: "current", idempotencyKey: "rerun-current" }), latest.res, context);
      expect(latest.read().body).toMatchObject({ definitionRevision: revised.revision, status: "running" }); expect(commands).toHaveLength(3);
      expect(definitionNotifications).toContainEqual({ workflowId: "event-flow", revision: revised.revision });
      expect(runNotifications.some((change) => change.runId === started[0]!.id)).toBe(true);
    } finally { service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("settles and extends a live attempt through its verified caller session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-attempt-api-"));
    const database = openWorkflowDatabase(path.join(root, "workflows.db"));
    const repository = new WorkflowRepository(database);
    const employee: Employee = { name: "worker", displayName: "Worker", department: "platform", rank: "employee",
      engine: "test-engine", model: "model-a", effortLevel: "high", persona: "Executes work." };
    const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "model-a", effortMechanism: "codex-config",
      models: [{ id: "model-a", label: "Model A", supportsEffort: true, effortLevels: ["high"] }] } };
    let attemptSessionId = "";
    const executor = {
      subscribe: () => () => undefined,
      async startAttempt(command: WorkflowAttemptCommand) {
        const session = createSession({
          engine: command.engine,
          source: "web",
          sourceRef: `workflow:${command.owner.runId}:${command.owner.nodeId}`,
          title: "Workflow attempt",
        });
        attemptSessionId = session.id;
        return { sessionId: session.id };
      },
      async stopAttempt() {},
      readTerminalCompletion: () => null,
      attemptState: () => ({ idle: true, runningChildren: 0 }),
      async remind() {},
    } as unknown as WorkflowSessionExecutor;
    const service = new WorkflowService({
      repository,
      executor,
      employees: () => new Map([[employee.name, employee]]),
      models: () => models,
    });
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    try {
      const missingCaller = response();
      await handleApiRequest(request("POST", "/api/workflows/attempts/submit", {}), missingCaller.res, context);
      expect(missingCaller.read()).toEqual({
        status: 409,
        body: { code: "not-a-workflow-attempt", message: "The caller is not a running Workflow attempt." },
      });

      const outsider = createSession({ engine: "test-engine", source: "web", sourceRef: "outsider", title: "Outsider" });
      const rejected = response();
      await handleApiRequest(request("POST", "/api/workflows/attempts/submit", {}, true, "application/json",
        workflowToolHeaders(outsider.id)), rejected.res, context);
      expect(rejected.read()).toEqual({
        status: 409,
        body: { code: "not-a-workflow-attempt", message: "The caller is not a running Workflow attempt." },
      });

      const created = service.createDefinition({ id: "submit-flow", title: "Submit flow" });
      const saved = service.saveDefinition({ ...created, nodes: [
        { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
        { id: "work", type: "employee", name: "Work", config: {
          employee: { source: "fixed", value: "worker" },
          prompt: "Report status.",
          output: { fields: { result: { type: "string", required: true } }, allowAdditionalFields: false },
        } },
        { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
      ], edges: [
        { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
        { id: "work-finish", from: { nodeId: "work", port: "success" }, to: { nodeId: "finish", port: "input" } },
      ] }, created.revision);
      const enabled = service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision });
      const run = await service.startManual({ workflowId: enabled.id, input: {} });
      const attempt = repository.findAttemptBySessionId(attemptSessionId)!;
      repository.mutateRun(run.id, service.getRun(saved.id, run.id)!.revision, (tx) => {
        tx.setAttemptReminder(attempt.nodeId, attempt.attempt, {
          remindersSent: 2,
          nextReminderAt: "2026-07-23T12:00:00.000Z",
          pendingOutputError: "result is required",
        });
      });

      const invalid = response();
      await handleApiRequest(request("POST", "/api/workflows/attempts/submit",
        { fields: {} }, true, "application/json", workflowToolHeaders(attemptSessionId)), invalid.res, context);
      expect(invalid.read()).toEqual({
        status: 422,
        body: { code: "missing-field", message: "Required output field \"result\" is missing." },
      });

      const extended = response();
      await handleApiRequest(request("POST", "/api/workflows/attempts/extend",
        { reason: "Waiting on review" }, true, "application/json", workflowToolHeaders(attemptSessionId)), extended.res, context);
      expect(extended.read()).toEqual({ status: 200, body: { ok: true } });
      expect(repository.findAttemptBySessionId(attemptSessionId)).toMatchObject({
        remindersSent: 0,
        extensions: 1,
        lastExtensionReason: "Waiting on review",
      });
      expect(repository.findAttemptBySessionId(attemptSessionId)?.nextReminderAt).toBeUndefined();
      expect(repository.findAttemptBySessionId(attemptSessionId)?.pendingOutputError).toBeUndefined();

      const submitted = response();
      await handleApiRequest(request("POST", "/api/workflows/attempts/submit",
        { fields: { result: "published" }, summary: "Done." }, true, "application/json",
        workflowToolHeaders(attemptSessionId)), submitted.res, context);
      expect(submitted.read()).toEqual({ status: 200, body: { ok: true } });
      expect(service.getRun(saved.id, run.id)).toMatchObject({ status: "completed" });

      const duplicate = response();
      await handleApiRequest(request("POST", "/api/workflows/attempts/submit",
        { fields: { result: "again" } }, true, "application/json",
        workflowToolHeaders(attemptSessionId)), duplicate.res, context);
      expect(duplicate.read()).toMatchObject({ status: 409, body: { code: "already-submitted" } });
    } finally {
      service.dispose();
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
