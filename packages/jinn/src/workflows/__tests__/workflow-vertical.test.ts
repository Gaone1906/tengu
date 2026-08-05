import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiContext } from "../../gateway/api.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  JINN_WORKFLOW_ATTEMPT_ENV,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import type {
  Employee,
  Engine,
  EngineResult,
  JinnConfig,
  ModelRegistry,
  WorkflowAttemptCompletion,
} from "../../shared/types.js";
import { createSession, getMessages, getSession, listSessions, updateSession } from "../../sessions/registry.js";
import { SessionManager } from "../../sessions/manager.js";
import type { Binding, JsonValue, WorkflowDefinition } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-vertical-sessions-"));
process.env.JINN_HOME = home;

const employee: Employee = {
  name: "writer", displayName: "Writer", department: "content", rank: "employee",
  engine: "claude", model: "opus", effortLevel: "high", persona: "Write the requested output.",
};
const config = {
  gateway: { port: 0, host: "127.0.0.1" },
  engines: {
    default: "codex",
    claude: { bin: process.execPath, model: "opus" },
    codex: { bin: process.execPath, model: "gpt" },
  },
  connectors: {}, logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: true }, browser: { enabled: false } },
} as unknown as JinnConfig;
const models: ModelRegistry = {
  claude: {
    name: "claude", available: true, defaultModel: "opus", effortMechanism: "claude-flag",
    models: [{ id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      { id: "sonnet", label: "Sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
    ],
  },
  codex: { name: "codex", available: true, defaultModel: "gpt", effortMechanism: "none", models: [{ id: "gpt", label: "GPT", supportsEffort: false, effortLevels: [] }] },
};

class DeferredEngine implements Engine {
  readonly name = "claude";
  readonly calls: Parameters<Engine["run"]>[0][] = [];
  readonly pending: Array<(result: EngineResult) => void> = [];
  readonly kills: Array<{ sessionId: string; reason?: string }> = [];
  beforeRun?: (sessionId: string) => void;
  run(opts: Parameters<Engine["run"]>[0]): Promise<EngineResult> {
    this.calls.push(opts);
    this.beforeRun?.(opts.sessionId!);
    return new Promise((resolve) => this.pending.push(resolve));
  }
  resolve(result: EngineResult): void { this.pending.shift()!(result); }
  kill(sessionId: string, reason?: string): void { this.kills.push({ sessionId, reason }); }
  isAlive(): boolean { return true; }
  killAll(): void {}
  killIdle(): void {}
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let engine: DeferredEngine;
let manager: SessionManager;
let service: WorkflowService;
let changes: Array<{ workflowId: string; runId: string }>;

function binding(value: string | Binding<string>): Binding<string> {
  return typeof value === "string" ? { source: "fixed", value } : value;
}

function definition(options: {
  id: string; trigger?: "manual" | "event"; eventName?: string;
  employee?: string | Binding<string>; engine?: Binding<string>; model?: Binding<string>; effort?: Binding<"low" | "medium" | "high">;
  prompt?: string; errorRoute?: boolean;
}): WorkflowDefinition {
  const created = repository.createDefinition({ id: options.id, title: `Flow ${options.id}` });
  const trigger = options.trigger === "event"
    ? { kind: "event" as const, eventName: options.eventName ?? "build.finished" }
    : { kind: "manual" as const };
  const saved = repository.saveDefinition({
    ...created,
    inputs: [
      { key: "employee", label: "Employee", type: "employee", required: false },
      { key: "engine", label: "Engine", type: "engine", required: false },
      { key: "model", label: "Model", type: "model", required: false },
      { key: "effort", label: "Effort", type: "string", required: false },
      { key: "topic", label: "Topic", type: "string", required: false },
    ],
    nodes: [
      { id: "start", type: "trigger", name: "Start", config: trigger },
      { id: "write", type: "employee", name: "Write", config: {
        employee: binding(options.employee ?? "writer"), prompt: options.prompt ?? "Write {{ input.topic }}.",
        ...(options.engine ? { engine: options.engine } : {}), ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        output: { fields: { result: { type: "string", required: true } }, allowAdditionalFields: false },
      } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
      ...(options.errorRoute
        ? [{ id: "handled", type: "end" as const, name: "Handled", config: { result: "success" as const } }]
        : []),
    ],
    edges: [
      { id: "start-write", from: { nodeId: "start", port: "success" }, to: { nodeId: "write", port: "input" } },
      { id: "write-finish", from: { nodeId: "write", port: "success" }, to: { nodeId: "finish", port: "input" } },
      ...(options.errorRoute
        ? [{ id: "write-handled", from: { nodeId: "write", port: "error" as const }, to: { nodeId: "handled", port: "input" as const } }]
        : []),
    ],
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

function request(pathname: string, sessionId: string, body: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url: pathname,
    headers: {
      host: "localhost",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: sessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
    },
  });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

function operatorRequest(pathname: string, body: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url: pathname,
    headers: {
      host: "localhost",
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
  });
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
  return {
    res,
    read: () => ({
      status,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : undefined,
    }),
  };
}

async function postAttempt(
  action: "submit" | "extend",
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const capture = response();
  const context = {
    gatewayAuthToken: "test-token",
    workflowService: service,
    getConfig: () => config,
    connectors: new Map(),
    sessionManager: manager,
    emit: vi.fn(),
    startTime: 1,
  } as unknown as ApiContext;
  await handleApiRequest(request(`/api/workflows/attempts/${action}`, sessionId, body), capture.res, context);
  return capture.read();
}

async function postSessionMessage(
  sessionId: string,
  message: string,
): Promise<{ status: number; body: unknown }> {
  const capture = response();
  const context = {
    gatewayAuthToken: "test-token",
    workflowService: service,
    getConfig: () => config,
    connectors: new Map(),
    sessionManager: manager,
    emit: vi.fn(),
    startTime: 1,
  } as unknown as ApiContext;
  await handleApiRequest(
    operatorRequest(`/api/sessions/${sessionId}/message`, { message }),
    capture.res,
    context,
  );
  return capture.read();
}

function createService(): WorkflowService {
  return new WorkflowService({
    repository,
    executor: new WorkflowSessionExecutor(manager, (sessionId) => {
      const session = getSession(sessionId);
      if (!session) return null;
      const finalText = [...getMessages(sessionId)].reverse().find((message) => message.role === "assistant")?.content;
      return { session, ...(finalText ? { finalText } : {}) };
    }),
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    onChange: (change) => { changes.push(change); },
  });
}

beforeEach(() => {
  setJinnAttachGate({ ok: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-vertical-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  engine = new DeferredEngine();
  manager = new SessionManager(config, new Map([["claude", engine], ["codex", engine]]), "vertical-boot", (id) => id === employee.name ? employee : undefined);
  changes = [];
  service = createService();
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
  setJinnAttachGate(null);
});

describe("first Workflow vertical", () => {
  it("Manual -> Employee -> End", async () => {
    const authored = definition({ id: "manual-flow" });
    let attemptWasDurable = false;
    engine.beforeRun = (sessionId) => {
      const attempt = repository.findAttemptBySessionId(sessionId);
      attemptWasDurable = attempt?.status === "running";
    };
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "release" }, idempotencyKey: "manual-1" });
    expect(started).toMatchObject({ definition: authored, input: { topic: "release" }, trigger: { nodeId: "start", kind: "manual", payload: {} } });
    expect(started.nodeRuns).toHaveLength(3);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    expect(attemptWasDurable).toBe(true);
    const attempt = repository.getRun(authored.id, started.id)!.attempts[0]!;
    expect(getSession(attempt.sessionId!)).toMatchObject({
      employee: "writer", engine: "claude", model: "opus",
      workflowProvenance: { kind: "phase", workflowId: authored.id, runId: started.id, phase: { nodeId: "write", attempt: 1 } },
    });
    expect(listSessions().map((session) => session.id)).not.toContain(attempt.sessionId);

    engine.resolve({ sessionId: "native-1", result: "Done.\n```jinn-output\n{\"result\":\"published\"}\n```", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, started.id)?.status).toBe("completed"));
    const completed = service.getRun(authored.id, started.id)!;
    expect(completed.attempts[0]).toMatchObject({ status: "completed", output: { text: "Done.\n", fields: { result: "published" }, employeeId: "writer", sessionId: attempt.sessionId } });
    expect(completed.nodeRuns.map((node) => node.status)).toEqual(["completed", "completed", "completed"]);
    expect(service.listRuns(authored.id, {}).items[0]).toMatchObject({ id: started.id, status: "completed" });
    expect(changes.at(-1)).toEqual({ workflowId: authored.id, runId: started.id });
  });

  it("persists failed history and recovery settles a lost live completion exactly once", async () => {
    const authored = definition({ id: "failure-flow" });
    const failed = await service.startManual({ workflowId: authored.id, input: { topic: "failure" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    engine.resolve({ sessionId: "", result: "", error: "provider failed", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, failed.id)?.status).toBe("failed"));
    expect(service.getRun(authored.id, failed.id)!.attempts[0]).toMatchObject({ status: "failed", error: { message: "provider failed" } });

    const lost = await service.startManual({ workflowId: authored.id, input: { topic: "recover" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    service.dispose();
    engine.resolve({ sessionId: "native-recovered", result: "Recovered.\n```jinn-output\n{\"result\":\"ok\"}\n```", durationMs: 1 });
    await vi.waitFor(() => expect(getSession(repository.getRun(authored.id, lost.id)!.attempts[0]!.sessionId!)?.attemptOutcome).toBe("succeeded"));

    manager = new SessionManager(config, new Map([["claude", engine], ["codex", engine]]), "reconstructed", (id) => id === employee.name ? employee : undefined);
    service = createService();
    expect(await service.recover(new Date().toISOString())).toEqual({ resumedRuns: 1, resumedWaits: 0 });
    expect(await service.recover(new Date().toISOString())).toEqual({ resumedRuns: 0, resumedWaits: 0 });
    expect(service.getRun(authored.id, lost.id)?.status).toBe("completed");
  });

  it.each([
    ["late success", { sessionId: "native-late-success", result: "Done.\n```jinn-output\n{\"result\":\"late\"}\n```", durationMs: 1 }],
    ["late failure", { sessionId: "", result: "", error: "late provider failure", durationMs: 1 }],
  ])("keeps cancellation first across %s without duplicate durable effects", async (_label, lateResult) => {
    const authored = definition({ id: `cancel-${"error" in lateResult ? "failure" : "success"}-flow` });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "cancel" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;

    const cancelled = await service.cancelRun({ workflowId: authored.id, runId: started.id, reason: "operator cancelled" });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nodeRuns.map((node) => node.status)).toEqual(["completed", "cancelled", "cancelled"]);
    expect(cancelled.attempts).toHaveLength(1);
    expect(cancelled.attempts[0]).toMatchObject({ status: "cancelled", sessionId, error: { code: "workflow-cancelled" } });
    expect(engine.kills).toEqual([{ sessionId, reason: "operator cancelled" }]);
    const terminalRevision = cancelled.revision;
    const terminalChanges = changes.length;

    engine.resolve(lateResult);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.getRun(authored.id, started.id)).toMatchObject({ status: "cancelled", revision: terminalRevision });
    expect(service.getRun(authored.id, started.id)!.nodeRuns.map((node) => node.status)).toEqual(["completed", "cancelled", "cancelled"]);
    expect(changes).toHaveLength(terminalChanges);
    expect(engine.kills).toHaveLength(1);
    await expect(service.cancelRun({ workflowId: authored.id, runId: started.id, reason: "duplicate" }))
      .rejects.toThrow(/already terminal/i);
    expect(service.getRun(authored.id, started.id)?.revision).toBe(terminalRevision);
    expect(changes).toHaveLength(terminalChanges);
    expect(engine.kills).toHaveLength(1);
  });

  it.each([
    ["success", { sessionId: "native-winner", result: "Done.\n```jinn-output\n{\"result\":\"winner\"}\n```", durationMs: 1 }, "completed"],
    ["failure", { sessionId: "", result: "", error: "provider won", durationMs: 1 }, "failed"],
  ] as const)("keeps terminal %s first when cancellation arrives later", async (_label, result, expectedStatus) => {
    const authored = definition({ id: `terminal-${expectedStatus}-flow` });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "terminal" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    engine.resolve(result);
    await vi.waitFor(() => expect(service.getRun(authored.id, started.id)?.status).toBe(expectedStatus));
    const terminal = service.getRun(authored.id, started.id)!;
    const terminalChanges = changes.length;

    await expect(service.cancelRun({ workflowId: authored.id, runId: started.id, reason: "too late" }))
      .rejects.toThrow(/already terminal/i);

    expect(service.getRun(authored.id, started.id)).toEqual(terminal);
    expect(changes).toHaveLength(terminalChanges);
    expect(engine.kills).toEqual([]);
  });

  it.each([
    ["engine registry defaults", { engine: { source: "input", path: "engine" } }, { engine: "codex", topic: "default" }, { engine: "codex", model: "gpt" }, "Write default."],
    ["model override defaults", { model: binding("sonnet") }, { topic: "default" }, { engine: "claude", model: "sonnet" }, "Write default."],
    ["employee defaults", {}, { topic: "default" }, { engine: "claude", model: "opus", effort: "high" }, "Write default."],
    ["dynamic explicit effort", { employee: { source: "input", path: "employee" }, engine: { source: "input", path: "engine" }, model: { source: "input", path: "model" }, effort: { source: "input", path: "effort" },
      prompt: "Handle {{ input.topic }} with {{ input.employee }}." }, { employee: "writer", engine: "claude", model: "sonnet", effort: "medium", topic: "dynamic" },
      { engine: "claude", model: "sonnet", effort: "medium" }, "Handle dynamic with writer."],
  ] as const)("resolves %s before dispatch", async (_label, overrides, input, expected, prompt) => {
    const authored = definition({ id: `dispatch-${_label.replaceAll(" ", "-")}`, ...overrides }); const started = await service.startManual({ workflowId: authored.id, input: { ...input } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    expect({ model: engine.calls[0]!.model, ...(engine.calls[0]!.effortLevel ? { effortLevel: engine.calls[0]!.effortLevel } : {}) }).toStrictEqual({ model: expected.model, ...("effort" in expected ? { effortLevel: expected.effort } : {}) });
    expect(service.getRun(authored.id, started.id)?.attempts[0]?.resolvedConfig).toStrictEqual({ employeeId: "writer", ...expected,
      retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" }, timeoutMinutes: 180 });
  });

  it("fails closed when a dynamic model is unavailable", async () => {
    const authored = definition({ id: "invalid-model", employee: { source: "input", path: "employee" }, engine: { source: "input", path: "engine" }, model: { source: "input", path: "model" } }); const invalid = await service.startManual({ workflowId: authored.id, input: { employee: "writer", engine: "claude", model: "unknown" } });
    expect(invalid.status).toBe("failed"); expect(invalid.attempts).toEqual([]); expect(engine.calls).toEqual([]);
  });

  it("fires bounded Event input internally through the same Employee vertical", async () => {
    const authored = definition({ id: "event-flow", trigger: "event", eventName: "build.finished", prompt: "Handle event." });
    const runs = await service.fireEvent({ eventName: "build.finished", fireId: "build-1", payload: { status: "passed" } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workflowId: authored.id, trigger: { kind: "event", fireId: "build-1", payload: { status: "passed" } } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    engine.resolve({ sessionId: "native-event", result: "Event done.\n```jinn-output\n{\"result\":\"ok\"}\n```", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, runs[0]!.id)?.status).toBe("completed"));
    await expect(service.fireEvent({ eventName: "build.finished", fireId: "build-2", payload: { data: "x".repeat(70_000) } })).rejects.toThrow(/64 KiB/);
  });

  it("completes a full run when the active attempt submits through the route mid-turn", async () => {
    const authored = definition({ id: "route-submit-flow" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "route" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;

    expect(await postAttempt("submit", sessionId, {
      fields: { result: "published" },
      summary: "Submitted while the turn was active.",
    })).toEqual({ status: 200, body: { ok: true } });
    expect(service.getRun(authored.id, started.id)).toMatchObject({
      status: "completed",
      attempts: [{
        status: "completed",
        sessionId,
        output: {
          text: "Submitted while the turn was active.",
          fields: { result: "published" },
        },
      }],
    });

    engine.resolve({ sessionId: "native-route-submit", result: "Turn ended after submission.", durationMs: 1 });
    await vi.waitFor(() => expect(getSession(sessionId)?.status).toBe("idle"));
    expect(service.getRun(authored.id, started.id)?.attempts[0]?.output?.fields).toEqual({ result: "published" });
  });

  it("keeps the attempt and run active when an operator message interrupts the current turn", async () => {
    const authored = definition({ id: "operator-interruption-turn-end" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "interrupt" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;

    expect(await postSessionMessage(sessionId, "Please also verify the release notes."))
      .toEqual({ status: 200, body: { status: "queued", sessionId } });
    expect(engine.kills).toEqual([{
      sessionId,
      reason: "Interrupted: new message received",
    }]);

    engine.resolve({
      sessionId: "native-interrupted",
      result: "",
      error: "Interrupted: new message received",
      durationMs: 1,
    });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    await vi.waitFor(() => {
      expect(service.getRun(authored.id, started.id)?.attempts[0]?.lastProcessedTurn).toBe(1);
    });
    const afterInterruption = service.getRun(authored.id, started.id)!;

    engine.resolve({ sessionId: "native-follow-up", result: "Still working.", durationMs: 1 });
    await vi.waitFor(() => expect(getSession(sessionId)?.status).toBe("idle"));

    expect(afterInterruption).toMatchObject({
      status: "running",
      attempts: [{
        status: "running",
        remindersSent: 0,
        lastProcessedTurn: 1,
        nextReminderAt: expect.any(String),
      }],
    });
  });

  it.each([
    ["drops the kill reason", {
      sessionId: "native-hermes-no-text",
      result: "",
      error: "hermes acp exited",
      durationMs: 1,
    }],
    ["returns partial text without an error", {
      sessionId: "native-hermes-partial",
      result: "Partial draft retained by the engine.",
      error: undefined,
      durationMs: 1,
    }],
  ] as const)("classifies an operator interruption at the API boundary when the engine %s", async (_label, interruptedResult) => {
    const authored = definition({ id: `boundary-interruption-${interruptedResult.sessionId}` });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "boundary" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;
    const completions: WorkflowAttemptCompletion[] = [];
    const unsubscribe = manager.subscribeWorkflowAttemptCompletion((event) => {
      completions.push(event);
    });

    await postSessionMessage(sessionId, "Preserve this follow-up across the interruption.");
    expect(getSession(sessionId)).toMatchObject({
      attemptInterruptionCause: "user-message",
      attemptInterruptionTurn: 1,
    });

    engine.resolve(interruptedResult);
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({
      sessionId,
      turn: 1,
      outcome: "interrupted",
      interruptionCause: "user-message",
    });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    await vi.waitFor(() => {
      expect(service.getRun(authored.id, started.id)?.attempts[0]?.lastProcessedTurn).toBe(1);
    });
    expect(service.getRun(authored.id, started.id)).toMatchObject({
      status: "running",
      attempts: [{
        status: "running",
        remindersSent: 0,
        lastProcessedTurn: 1,
        nextReminderAt: expect.any(String),
      }],
    });

    expect(await postAttempt("submit", sessionId, {
      fields: { result: "published" },
      summary: "Submitted after the transformed interruption.",
    })).toEqual({ status: 200, body: { ok: true } });
    engine.resolve({ sessionId: "native-hermes-follow-up", result: "Submitted.", durationMs: 1 });
    await vi.waitFor(() => expect(getSession(sessionId)?.status).toBe("idle"));
    expect(service.getRun(authored.id, started.id)).toMatchObject({
      status: "completed",
      attempts: [{
        status: "completed",
        remindersSent: 0,
        output: {
          fields: { result: "published" },
          text: "Submitted after the transformed interruption.",
        },
      }],
    });
    unsubscribe();
  });

  it("completes after an operator interruption and additional workflow-session turns", async () => {
    const authored = definition({ id: "submit-after-operator-turns" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "continue" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;

    await postSessionMessage(sessionId, "Add one more verification.");
    engine.resolve({
      sessionId: "native-interrupted-before-submit",
      result: "",
      error: "Interrupted: new message received",
      durationMs: 1,
    });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    engine.resolve({ sessionId: "native-extra-turn", result: "Verification added.", durationMs: 1 });
    await vi.waitFor(() => expect(getSession(sessionId)?.status).toBe("idle"));

    await postSessionMessage(sessionId, "Submit once the summary is ready.");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(3));
    const followUpJinnServer = engine.calls[2]?.resolvedMcp?.mcpServers.jinn;
    const submission = await postAttempt("submit", sessionId, {
      fields: { result: "published" },
      summary: "Submitted after the operator follow-ups.",
    });

    engine.resolve({ sessionId: "native-submit-turn", result: "Submitted.", durationMs: 1 });
    await vi.waitFor(() => expect(getSession(sessionId)?.status).toBe("idle"));

    expect(followUpJinnServer).toMatchObject({
      env: expect.objectContaining({ [JINN_WORKFLOW_ATTEMPT_ENV]: "1" }),
    });
    expect(submission).toEqual({ status: 200, body: { ok: true } });
    expect(service.getRun(authored.id, started.id)).toMatchObject({
      status: "completed",
      attempts: [{
        status: "completed",
        output: {
          fields: { result: "published" },
          text: "Submitted after the operator follow-ups.",
        },
      }],
    });
  });

  it("advances the turn fence without consuming reminder rungs across operator follow-ups", async () => {
    const authored = definition({ id: "operator-turn-fence" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "fence" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;

    await postSessionMessage(sessionId, "First follow-up.");
    engine.resolve({
      sessionId: "native-fence-interrupted",
      result: "",
      error: "Interrupted: new message received",
      durationMs: 1,
    });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    engine.resolve({ sessionId: "native-fence-two", result: "Continuing.", durationMs: 1 });
    await vi.waitFor(() => {
      expect(service.getRun(authored.id, started.id)?.attempts[0]?.lastProcessedTurn).toBe(2);
    });

    await postSessionMessage(sessionId, "Second follow-up.");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(3));
    engine.resolve({ sessionId: "native-fence-three", result: "Continuing again.", durationMs: 1 });
    await vi.waitFor(() => {
      expect(service.getRun(authored.id, started.id)?.attempts[0]?.lastProcessedTurn).toBe(3);
    });

    expect(service.getRun(authored.id, started.id)).toMatchObject({
      status: "running",
      attempts: [{
        status: "running",
        remindersSent: 0,
        lastProcessedTurn: 3,
        nextReminderAt: expect.any(String),
      }],
    });
  });

  it("keeps run cancellation terminal while its interrupted engine turn settles", async () => {
    const authored = definition({ id: "run-cancel-remains-terminal" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "cancel" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));

    const cancelled = await service.cancelRun({
      workflowId: authored.id,
      runId: started.id,
      reason: "Run cancelled by operator.",
    });
    engine.resolve({
      sessionId: "native-cancelled",
      result: "",
      error: "Run cancelled by operator.",
      durationMs: 1,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(cancelled).toMatchObject({
      status: "cancelled",
      attempts: [{ status: "cancelled" }],
    });
    expect(service.getRun(authored.id, started.id)).toEqual(cancelled);
  });

  it("keeps an explicit stopWorkflowAttempt interruption on the cancellation path", async () => {
    const authored = definition({ id: "explicit-attempt-stop" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "stop" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;

    await manager.stopWorkflowAttempt({ sessionId, reason: "Attempt stopped explicitly." });
    await vi.waitFor(() => {
      expect(service.getRun(authored.id, started.id)?.attempts[0]?.status).toBe("cancelled");
    });
    const stopped = service.getRun(authored.id, started.id)!;

    engine.resolve({ sessionId: "native-stopped-late", result: "Too late.", durationMs: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopped.attempts[0]).toMatchObject({ status: "cancelled" });
    expect(service.getRun(authored.id, started.id)?.attempts[0]).toMatchObject({ status: "cancelled" });
    expect(engine.kills).toEqual([{ sessionId, reason: "Attempt stopped explicitly." }]);
  });

  it("publishes the shared stopped-session lifecycle event for Workflow-internal cancellation", async () => {
    const authored = definition({ id: "internal-cancel-event" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "stop" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;
    const emit = vi.fn();
    ;(manager as unknown as { setGatewayEmitter: (next: typeof emit) => void }).setGatewayEmitter?.(emit)

    await service.cancelRun({ workflowId: authored.id, runId: started.id, reason: "Cancelled inside Workflow." });

    expect(emit).toHaveBeenCalledWith("session:stopped", { sessionId });
  });

  it("defers the reminder rung for a running child, then accepts the parent's route submission", async () => {
    const authored = definition({ id: "delegated-route-submit-flow" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "delegated" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;
    const child = createSession({
      engine: "claude",
      source: "web",
      sourceRef: `delegated:${started.id}`,
      parentSessionId: sessionId,
      employee: "writer",
      title: "Delegated child",
    });
    updateSession(child.id, { status: "running" });

    engine.resolve({ sessionId: "native-delegated-parent", result: "Waiting for delegated work.", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, started.id)?.attempts[0]?.nextReminderAt).toBeDefined());
    const firstDue = service.getRun(authored.id, started.id)!.attempts[0]!.nextReminderAt!;
    expect(manager.workflowAttemptState(sessionId)).toMatchObject({ idle: true, runningChildren: 1 });

    await service.recover(firstDue);

    const deferred = service.getRun(authored.id, started.id)!.attempts[0]!;
    expect(deferred).toMatchObject({
      status: "running",
      remindersSent: 0,
      nextReminderAt: new Date(Date.parse(firstDue) + 5 * 60_000).toISOString(),
    });
    expect(engine.calls).toHaveLength(1);

    updateSession(child.id, {
      status: "idle",
      attemptOutcome: "succeeded",
      attemptTerminalVersion: 1,
      attemptTurn: 1,
    });
    expect(manager.workflowAttemptState(sessionId)).toMatchObject({ idle: true, runningChildren: 0 });
    expect(await postAttempt("submit", sessionId, {
      fields: { result: "delegated result" },
      summary: "Child completed; parent submitted.",
    })).toEqual({ status: 200, body: { ok: true } });
    expect(service.getRun(authored.id, started.id)).toMatchObject({
      status: "completed",
      attempts: [{ status: "completed", output: { fields: { result: "delegated result" } } }],
    });
  });

  it("fails after reminder exhaustion with workflow-no-output and follows the error port", async () => {
    const authored = definition({ id: "vertical-no-output-route", errorRoute: true });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "silent" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));

    engine.resolve({ sessionId: "native-no-output-1", result: "Still working.", durationMs: 1 });
    for (let rung = 1; rung <= 3; rung += 1) {
      await vi.waitFor(() => expect(service.getRun(authored.id, started.id)?.attempts[0]?.nextReminderAt).toBeDefined());
      const due = service.getRun(authored.id, started.id)!.attempts[0]!.nextReminderAt!;
      await service.recover(due);
      await vi.waitFor(() => expect(engine.calls).toHaveLength(rung + 1));
      expect(service.getRun(authored.id, started.id)?.attempts[0]?.remindersSent).toBe(rung);
      engine.resolve({ sessionId: `native-no-output-${rung + 1}`, result: "Still no submission.", durationMs: 1 });
    }

    await vi.waitFor(() => expect(service.getRun(authored.id, started.id)?.status).toBe("completed"));
    const completed = service.getRun(authored.id, started.id)!;
    expect(completed.attempts[0]).toMatchObject({
      status: "failed",
      error: { code: "workflow-no-output", retryable: true },
    });
    expect(completed.nodeRuns.find((node) => node.nodeId === "write")).toMatchObject({
      status: "failed",
      error: { code: "workflow-no-output" },
    });
    expect(completed.nodeRuns.find((node) => node.nodeId === "handled")?.status).toBe("completed");
  });

  it("resets the reminder ladder through the deadline-extension route", async () => {
    const authored = definition({ id: "vertical-extend-route" });
    const started = await service.startManual({ workflowId: authored.id, input: { topic: "extension" } });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const sessionId = service.getRun(authored.id, started.id)!.attempts[0]!.sessionId!;

    engine.resolve({ sessionId: "native-before-extension", result: "Need more time.", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, started.id)?.attempts[0]?.nextReminderAt).toBeDefined());
    const due = service.getRun(authored.id, started.id)!.attempts[0]!.nextReminderAt!;
    await service.recover(due);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    expect(service.getRun(authored.id, started.id)?.attempts[0]?.remindersSent).toBe(1);

    expect(await postAttempt("extend", sessionId, { reason: "Waiting for review." }))
      .toEqual({ status: 200, body: { ok: true } });
    expect(service.getRun(authored.id, started.id)?.attempts[0]).toMatchObject({
      status: "running",
      remindersSent: 0,
      extensions: 1,
      lastExtensionReason: "Waiting for review.",
    });
    expect(service.getRun(authored.id, started.id)?.attempts[0]?.nextReminderAt).toBeUndefined();

    engine.resolve({ sessionId: "native-after-extension", result: "Continuing after extension.", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, started.id)?.attempts[0]?.nextReminderAt).toBeDefined());
    const resetDue = service.getRun(authored.id, started.id)!.attempts[0]!.nextReminderAt!;
    expect(Date.parse(resetDue) - Date.parse(getSession(sessionId)!.lastActivity)).toBe(5 * 60_000);
  });
});
