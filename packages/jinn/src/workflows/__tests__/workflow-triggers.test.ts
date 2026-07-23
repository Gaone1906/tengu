import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent } from "../../work-items/workflow-event-feed.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

const scheduled: Array<{ callback: () => void | Promise<void>; stop: ReturnType<typeof vi.fn> }> = [];
vi.mock("node-cron", () => ({ default: { schedule: vi.fn((_cron, callback) => {
  const task = { callback, stop: vi.fn() }; scheduled.push(task); return task;
}) } }));

const employee: Employee = { name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };
class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command); return { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  readTerminalCompletion(): null { return null; }
}

class TodoFeed implements WorkflowTodoEventFeed {
  readonly pending: WorkflowTodoStatusEvent[] = [];
  readonly processed = new Map<string, WorkflowTodoEventClaimOutcome[]>();
  claimEvent(id: string, definitionIds: string[]) {
    const prior = this.processed.get(id); return prior ? { state: "processed" as const, outcomes: prior }
      : { state: "acquired" as const, definitionIds };
  }
  completeEvent(id: string, outcomes: WorkflowTodoEventClaimOutcome[]): void { this.processed.set(id, outcomes); }
  releaseEvent(): void {}
  listPendingEvents(): WorkflowTodoStatusEvent[] { return this.pending.filter((event) => !this.processed.has(event.id)); }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let feed: TodoFeed;
let service: WorkflowService;
let now: string;

function edge(id: string, from: string, to: string) {
  return { id, from: { nodeId: from, port: "success" as const }, to: { nodeId: to, port: "input" as const } };
}
function save(id: string, trigger: WorkflowNode, enabled = true): WorkflowDefinition {
  const draft = service.createDefinition({ id, title: id });
  const worker: WorkflowNode = { id: "work", type: "employee", name: "Work", config: {
    employee: { source: "fixed", value: "worker" }, prompt: "Do work.",
    retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" }, timeoutMinutes: 1 } };
  const end: WorkflowNode = { id: "finish", type: "end", name: "Finish", config: { result: "success" } };
  const saved = service.saveDefinition({ ...draft, nodes: [trigger, worker, end],
    edges: [edge("trigger-work", trigger.id, "work"), edge("work-end", "work", "finish")] }, draft.revision);
  return enabled ? service.setEnabled({ id, enabled: true, expectedRevision: saved.revision }) : saved;
}
function buildService(): WorkflowService {
  return new WorkflowService({ repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now, todoEventFeed: feed });
}

beforeEach(() => {
  scheduled.length = 0; root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-triggers-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db")); now = "2026-07-21T12:00:00.000Z";
  repository = new WorkflowRepository(database, () => now); executor = new Executor(); feed = new TodoFeed(); service = buildService();
});
afterEach(() => { service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("Workflow trigger adapters", () => {
  it("rebuilds only enabled Schedule definitions and fires each instant idempotently across restart and disable", async () => {
    const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Schedule", config: { kind: "schedule", cron: "0 * * * *", timezone: "UTC" } };
    const definition = save("scheduled-flow", trigger, false);
    service.saveDefinition(repository.getDefinition(definition.id)!, definition.revision);
    expect(scheduled).toHaveLength(0);
    service.setEnabled({ id: definition.id, enabled: true, expectedRevision: definition.revision + 1 });
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!.callback(); await scheduled[0]!.callback();
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);

    const enabled = repository.getDefinition(definition.id)!;
    service.setEnabled({ id: definition.id, enabled: false, expectedRevision: enabled.revision });
    expect(scheduled[0]!.stop).toHaveBeenCalledOnce();
    now = "2026-07-21T13:00:00.000Z"; await scheduled[0]!.callback();
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
    service.dispose(); service = buildService(); expect(scheduled).toHaveLength(1);
  });

  it("claims the existing Todo feed against its enabled in-memory index without duplicate fires", async () => {
    const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Todo", config: { kind: "todo-status", status: "in_review" } };
    const definition = save("todo-flow", trigger);
    feed.pending.push({ id: "event-1", workItemId: "ICI-1", fromStatus: "executing", toStatus: "in_review",
      item: { source: "human", department: "platform", assignee: "worker" } });
    await service.recover(now); await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
    expect(feed.processed.get("event-1")).toMatchObject([{ workflowId: definition.id, outcome: "started" }]);

    const enabled = repository.getDefinition(definition.id)!;
    service.setEnabled({ id: definition.id, enabled: false, expectedRevision: enabled.revision });
    feed.pending.push({ ...feed.pending[0]!, id: "event-2" }); await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
  });

  it("calls only a workflow-call target, freezes caller identity, and creates fresh Employee sessions", async () => {
    const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Called", config: { kind: "workflow-call" } };
    const definition = save("called-flow", trigger);
    const other = save("called-other", trigger);
    const parent = save("parent-flow", { id: "start", type: "trigger", name: "Manual", config: { kind: "manual" } });
    const parentRun = await service.startManual({ workflowId: parent.id, input: {} });
    const alternateRun = await service.startManual({ workflowId: parent.id, input: {} });
    const caller = { workflowId: parent.id, runId: parentRun.id, nodeId: "work" };
    const alternateCaller = { workflowId: parent.id, runId: alternateRun.id, nodeId: "work" };
    executor.commands.length = 0;
    await expect(service.callWorkflow({ workflowId: definition.id, caller, input: {}, idempotencyKey: "x".repeat(129) }))
      .rejects.toThrow(/idempotency key/i);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    const first = await service.callWorkflow({ workflowId: definition.id, caller, input: { topic: "release" }, idempotencyKey: "x".repeat(128) });
    const replay = await service.callWorkflow({ workflowId: definition.id, caller, input: { topic: "release" }, idempotencyKey: "x".repeat(128) });
    const second = await service.callWorkflow({ workflowId: definition.id, caller, input: { topic: "release" }, idempotencyKey: "call-2" });
    expect(replay.id).toBe(first.id); expect(second.id).not.toBe(first.id);
    expect(first.trigger).toMatchObject({ kind: "workflow-call", payload: { caller } });
    expect(new Set(executor.commands.map((command) => command.owner.runId))).toEqual(new Set([first.id, second.id]));
    await service.cancelRun({ workflowId: parent.id, runId: parentRun.id, reason: "Caller finished." });
    const terminalReplay = await service.callWorkflow({ workflowId: definition.id, caller,
      input: { topic: "release" }, idempotencyKey: "x".repeat(128) });
    expect(terminalReplay).toMatchObject({ id: first.id, revision: first.revision });
    for (const changed of [
      { workflowId: definition.id, caller, input: { topic: "changed" } },
      { workflowId: definition.id, caller: alternateCaller, input: { topic: "release" } },
      { workflowId: other.id, caller: alternateCaller, input: { topic: "release" } },
    ]) await expect(service.callWorkflow({ ...changed, idempotencyKey: "x".repeat(128) })).rejects.toThrow(/idempotency/i);
    expect(executor.commands).toHaveLength(2);

    const manual: WorkflowNode = { id: "start", type: "trigger", name: "Manual", config: { kind: "manual" } };
    const wrong = save("manual-flow", manual);
    await expect(service.callWorkflow({ workflowId: wrong.id, caller, input: {}, idempotencyKey: "bad-call" }))
      .rejects.toThrow(/workflow-call/i);
  });

  it("rejects arbitrary Workflow Call identities, self-recursion, ancestry cycles, and oversized IDs", async () => {
    const callTrigger = (name: string): WorkflowNode => ({ id: "start", type: "trigger", name, config: { kind: "workflow-call" } });
    const parent = save("call-parent", { id: "start", type: "trigger", name: "Manual", config: { kind: "manual" } });
    const first = save("call-first", callTrigger("First"));
    const second = save("call-second", callTrigger("Second"));
    const parentRun = await service.startManual({ workflowId: parent.id, input: {} });
    const parentCaller = { workflowId: parent.id, runId: parentRun.id, nodeId: "work" };

    await expect(service.callWorkflow({ workflowId: first.id,
      caller: { ...parentCaller, runId: "run_missing" }, input: {}, idempotencyKey: "missing" }))
      .rejects.toThrow(/caller/i);
    await expect(service.callWorkflow({ workflowId: first.id,
      caller: { ...parentCaller, nodeId: "start" }, input: {}, idempotencyKey: "wrong-node" }))
      .rejects.toThrow(/caller/i);
    await expect(service.callWorkflow({ workflowId: first.id,
      caller: { ...parentCaller, workflowId: "x".repeat(129) }, input: {}, idempotencyKey: "oversized" }))
      .rejects.toThrow(/identity/i);

    const firstRun = await service.callWorkflow({ workflowId: first.id, caller: parentCaller, input: {}, idempotencyKey: "first" });
    const firstCaller = { workflowId: first.id, runId: firstRun.id, nodeId: "work" };
    await expect(service.callWorkflow({ workflowId: first.id, caller: firstCaller, input: {}, idempotencyKey: "self" }))
      .rejects.toThrow(/recursion/i);
    const secondRun = await service.callWorkflow({ workflowId: second.id, caller: firstCaller, input: {}, idempotencyKey: "second" });
    const secondCaller = { workflowId: second.id, runId: secondRun.id, nodeId: "work" };
    await expect(service.callWorkflow({ workflowId: first.id, caller: secondCaller, input: {}, idempotencyKey: "cycle" }))
      .rejects.toThrow(/recursion/i);
  });
});
