import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { Binding, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository, WorkflowRepositoryError } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService, WorkflowServiceError } from "../service.js";

class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readTerminalCompletion(): null { return null; }
}

const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } };
const scheduleTrigger: WorkflowNode = { id: "start", type: "trigger", name: "Start",
  config: { kind: "schedule", cron: "0 * * * *", timezone: "UTC" } };
const eventTrigger: WorkflowNode = { id: "start", type: "trigger", name: "Start",
  config: { kind: "event", eventName: "build.finished" } };
const finish: WorkflowNode = { id: "finish", type: "end", name: "Finish", config: { result: "success" } };
const employee: Employee = { name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };
const edge = (id: string, from: string, to: string) => ({
  id,
  from: { nodeId: from, port: "success" as const },
  to: { nodeId: to, port: "input" as const },
});

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let definitionChanges: Array<{ workflowId: string; revision: number }>;
let runChanges: Array<{ workflowId: string; runId: string }>;
let service: WorkflowService;

function save(id: string, nodes: WorkflowNode[], edges: ReturnType<typeof edge>[]): WorkflowDefinition {
  const created = service.createDefinition({ id, title: id });
  definitionChanges.length = 0;
  return service.saveDefinition({ ...created, nodes, edges }, created.revision);
}

function worker(employee: Binding<string> = { source: "fixed", value: "worker" }): WorkflowNode {
  return { id: "work", type: "employee", name: "Work", config: { employee, prompt: "Do work." } };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-service-validation-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => "2026-07-22T10:00:00.000Z");
  executor = new Executor();
  definitionChanges = [];
  runChanges = [];
  service = new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    onDefinitionChange: (change) => definitionChanges.push(change),
    onChange: (change) => runChanges.push(change),
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Workflow executable service boundaries", () => {
  it("rejects zero-node enable without changing the stored definition", () => {
    const created = service.createDefinition({ id: "empty-flow", title: "Empty flow" });
    definitionChanges.length = 0;
    let caught: unknown;

    expect(() => service.setEnabled({ id: created.id, enabled: true, expectedRevision: created.revision + 1 }))
      .toThrow(expect.objectContaining<Partial<WorkflowRepositoryError>>({ code: "revision-conflict" }));
    try { service.setEnabled({ id: created.id, enabled: true, expectedRevision: created.revision }); }
    catch (error) { caught = error; }

    expect(caught).toEqual(new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", [
      { code: "missing-end-path", message: "A Trigger must have a directed path to an End." },
      { code: "trigger-count", message: "Workflow must contain exactly one Trigger." },
    ]));
    expect(repository.getDefinition(created.id)).toEqual(created);
    expect(definitionChanges).toEqual([]);
    expect(service.listRuns(created.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
  });

  it("rejects manual-trigger-only run before creating a run or dispatching a session", async () => {
    const saved = save("manual-only", [trigger], []);
    const enabled = repository.setEnabled(saved.id, true, saved.revision);
    definitionChanges.length = 0;
    let caught: unknown;

    try { await service.startManual({ workflowId: enabled.id, input: {} }); }
    catch (error) { caught = error; }

    expect(caught).toEqual(new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", [
      { code: "dead-node", message: "Reachable non-End node has no path to an End.", nodeId: "start" },
      { code: "missing-end-path", message: "A Trigger must have a directed path to an End." },
    ]));
    expect(service.listRuns(enabled.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
    expect(repository.getDefinition(enabled.id)).toEqual(enabled);
  });

  it("validates an enabled revision that deleted its Manual trigger before requiring that trigger", async () => {
    const authored = save("deleted-manual", [trigger, finish], [edge("start-finish", "start", "finish")]);
    const enabled = service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision });
    const revised = service.saveDefinition({ ...enabled, nodes: [finish], edges: [] }, enabled.revision);
    definitionChanges.length = 0;

    await expect(service.startManual({ workflowId: revised.id, input: {} })).rejects.toEqual(
      new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", [
        { code: "unreachable-node", message: "Node is not reachable from a Trigger.", nodeId: "finish" },
        { code: "missing-end-path", message: "A Trigger must have a directed path to an End." },
        { code: "trigger-count", message: "Workflow must contain exactly one Trigger." },
      ]),
    );
    expect(revised).toMatchObject({ enabled: true, revision: enabled.revision + 1 });
    expect(repository.getDefinition(revised.id)).toEqual(revised);
    expect(definitionChanges).toEqual([]);
    expect(service.listRuns(revised.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
  });

  it.each([
    ["Schedule", scheduleTrigger],
    ["Event", eventTrigger],
  ])("keeps valid %s-only workflows executable before returning the no-Manual-trigger error", async (label, authoredTrigger) => {
    const authored = save(`valid-${label.toLowerCase()}`, [authoredTrigger, finish], [edge("start-finish", "start", "finish")]);
    const enabled = service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision });
    definitionChanges.length = 0;

    await expect(service.startManual({ workflowId: enabled.id, input: {} })).rejects.toEqual(
      new WorkflowRepositoryError("bad-input", "Workflow does not have an enabled manual trigger."),
    );
    expect(repository.getDefinition(enabled.id)).toEqual(enabled);
    expect(definitionChanges).toEqual([]);
    expect(service.listRuns(enabled.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
  });

  it("keeps disabled and absent workflow manual-start errors unchanged", async () => {
    const disabled = save("disabled-flow", [trigger, finish], [edge("start-finish", "start", "finish")]);
    definitionChanges.length = 0;

    for (const workflowId of [disabled.id, "missing-flow"]) {
      await expect(service.startManual({ workflowId, input: {} })).rejects.toEqual(
        new WorkflowRepositoryError("bad-input", "Workflow does not have an enabled manual trigger."),
      );
    }
    expect(repository.getDefinition(disabled.id)).toEqual(disabled);
    expect(definitionChanges).toEqual([]);
    expect(service.listRuns(disabled.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
  });

  it("preserves canonical field issue order, path, code, and message", () => {
    const authored = save("invalid-field", [
      trigger,
      worker({ source: "input", path: "assignee" }),
      finish,
    ], [edge("start-work", "start", "work"), edge("work-finish", "work", "finish")]);
    const expected = [{
      code: "undeclared-input",
      message: "Input binding references an undeclared Workflow input.",
      nodeId: "work",
      path: "nodes.1.config.employee",
    }];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let caught: unknown;
      try { service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision }); }
      catch (error) { caught = error; }
      expect(caught).toEqual(new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", expected));
    }
    expect(repository.getDefinition(authored.id)).toEqual(authored);
    expect(definitionChanges).toEqual([{ workflowId: authored.id, revision: authored.revision }]);
  });

  it("keeps valid enable, revision conflicts, and manual dispatch behavior unchanged", async () => {
    const authored = save("valid-flow", [trigger, worker(), finish], [
      edge("start-work", "start", "work"),
      edge("work-finish", "work", "finish"),
    ]);

    expect(() => service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision + 1 }))
      .toThrow(expect.objectContaining<Partial<WorkflowRepositoryError>>({ code: "revision-conflict" }));
    expect(repository.getDefinition(authored.id)).toEqual(authored);
    const enabled = service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision });
    expect(enabled).toMatchObject({ enabled: true, revision: authored.revision + 1 });

    const run = await service.startManual({ workflowId: enabled.id, input: {}, idempotencyKey: "valid-1" });
    const replay = await service.startManual({ workflowId: enabled.id, input: {}, idempotencyKey: "valid-1" });
    expect(run).toMatchObject({ workflowId: enabled.id, status: "running", definitionRevision: enabled.revision });
    expect(replay.id).toBe(run.id);
    expect(service.listRuns(enabled.id, {}).items).toHaveLength(1);
    expect(executor.commands).toHaveLength(1);
  });
});
