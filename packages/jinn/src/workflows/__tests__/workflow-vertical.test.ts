import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, Engine, EngineResult, JinnConfig, ModelRegistry } from "../../shared/types.js";
import { getMessages, getSession, listSessions } from "../../sessions/registry.js";
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
  engines: { default: "codex", claude: { bin: "", model: "opus" }, codex: { bin: "", model: "gpt" } },
  connectors: {}, logging: { file: false, stdout: false, level: "error" },
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
  prompt?: string;
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
    ],
    edges: [
      { id: "start-write", from: { nodeId: "start", port: "success" }, to: { nodeId: "write", port: "input" } },
      { id: "write-finish", from: { nodeId: "write", port: "success" }, to: { nodeId: "finish", port: "input" } },
    ],
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-vertical-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  engine = new DeferredEngine();
  manager = new SessionManager(config, new Map([["claude", engine], ["codex", engine]]), [], "vertical-boot", (id) => id === employee.name ? employee : undefined);
  changes = [];
  service = createService();
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
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

    manager = new SessionManager(config, new Map([["claude", engine], ["codex", engine]]), [], "reconstructed", (id) => id === employee.name ? employee : undefined);
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
      retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" } });
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
});
