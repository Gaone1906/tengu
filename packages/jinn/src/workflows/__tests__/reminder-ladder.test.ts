import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { WorkflowDefinition, WorkflowOutputSchema } from "../model.js";
import { WorkflowOutputError } from "../output.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository, WorkflowRepositoryError } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

const employee: Employee = {
  name: "worker",
  displayName: "Worker",
  department: "operations",
  rank: "employee",
  engine: "test-engine",
  model: "test-model",
  effortLevel: "high",
  persona: "Complete the workflow step.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine",
    available: true,
    defaultModel: "test-model",
    effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

class FakeExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  readonly reminders: Array<{ sessionId: string; text: string }> = [];
  readonly states = new Map<string, { idle: boolean; runningChildren: number }>();
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  private readonly turns = new Map<string, number>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    const sessionId = this.sessionId(command);
    this.states.set(sessionId, { idle: true, runningChildren: 0 });
    return { sessionId };
  }
  async stopAttempt(): Promise<void> {}
  async remind(input: { sessionId: string; text: string }): Promise<void> {
    this.reminders.push(input);
  }
  attemptState(sessionId: string): { idle: boolean; runningChildren: number } | null {
    return this.states.get(sessionId) ?? null;
  }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  async turnEnd(finalText = "Still working.", outcome: WorkflowAttemptCompletion["outcome"] = "succeeded"): Promise<void> {
    const command = this.commands.at(-1)!;
    const sessionId = this.sessionId(command);
    const turn = (this.turns.get(sessionId) ?? 0) + 1;
    this.turns.set(sessionId, turn);
    const event: WorkflowAttemptCompletion = {
      sessionId,
      owner: command.owner,
      turn,
      terminalVersion: 1,
      outcome,
      ...(outcome === "succeeded" ? { finalText } : { error: finalText }),
      completedAt: now,
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
  sessionId(command = this.commands.at(-1)!): string {
    return `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`;
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let service: WorkflowService;
let now: string;

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}

function saveDefinition(input: {
  id: string;
  output?: WorkflowOutputSchema;
  retries?: number;
  errorRoute?: boolean;
}): WorkflowDefinition {
  const created = repository.createDefinition({ id: input.id, title: input.id });
  const nodes: WorkflowDefinition["nodes"] = [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    {
      id: "work",
      type: "employee",
      name: "Work",
      config: {
        employee: { source: "fixed", value: "worker" },
        prompt: "Complete the work.",
        ...(input.output ? { output: input.output } : {}),
        retry: { attempts: input.retries ?? 1, delaySeconds: 0, backoff: "fixed" },
      },
    },
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ...(input.errorRoute
      ? [{ id: "handled", type: "end" as const, name: "Handled", config: { result: "success" as const } }]
      : []),
  ];
  const edges = [
    edge("start-work", "start", "success", "work"),
    edge("work-finish", "work", "success", "finish"),
    ...(input.errorRoute ? [edge("work-error", "work", "error", "handled")] : []),
  ];
  const saved = repository.saveDefinition({ ...created, nodes, edges }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

async function start(input: Parameters<typeof saveDefinition>[0]) {
  const definition = saveDefinition(input);
  const run = await service.startManual({ workflowId: definition.id, input: {} });
  return { definition, run, sessionId: executor.sessionId() };
}

async function recover(at: string): Promise<void> {
  now = at;
  await service.recover(now);
}

async function sendThreeReminders(): Promise<void> {
  await executor.turnEnd();
  await recover("2026-07-21T10:05:00.000Z");
  await executor.turnEnd();
  await recover("2026-07-21T10:20:00.000Z");
  await executor.turnEnd();
  await recover("2026-07-21T10:50:00.000Z");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-reminder-ladder-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  now = "2026-07-21T10:00:00.000Z";
  repository = new WorkflowRepository(database, () => now);
  executor = new FakeExecutor();
  service = new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    now: () => now,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow explicit completion and reminder ladder", () => {
  it("schedules the first reminder five minutes after a tool-less turn end", async () => {
    const { definition, run } = await start({ id: "first-rung" });
    await executor.turnEnd();

    expect(service.getRun(definition.id, run.id)?.attempts[0]).toMatchObject({
      status: "running",
      remindersSent: 0,
      nextReminderAt: "2026-07-21T10:05:00.000Z",
    });
  });

  it("escalates through 5/15/30 minute rungs and adds the extension instruction to the third", async () => {
    const { definition, run } = await start({ id: "three-rungs" });
    await executor.turnEnd();
    await recover("2026-07-21T10:05:00.000Z");
    expect(service.getRun(definition.id, run.id)?.attempts[0]).toMatchObject({
      remindersSent: 1,
    });
    expect(service.getRun(definition.id, run.id)?.attempts[0]?.nextReminderAt).toBeUndefined();
    await executor.turnEnd();
    expect(service.getRun(definition.id, run.id)?.attempts[0]?.nextReminderAt)
      .toBe("2026-07-21T10:20:00.000Z");
    await recover("2026-07-21T10:20:00.000Z");
    await executor.turnEnd();
    expect(service.getRun(definition.id, run.id)?.attempts[0]?.nextReminderAt)
      .toBe("2026-07-21T10:50:00.000Z");
    await recover("2026-07-21T10:50:00.000Z");

    expect(service.getRun(definition.id, run.id)?.attempts[0]).toMatchObject({ remindersSent: 3 });
    expect(executor.reminders).toHaveLength(3);
    expect(executor.reminders[2]?.text).toContain("final reminder");
    expect(executor.reminders[2]?.text).toContain("workflow_extend_deadline");
  });

  it("defers busy and child-active sessions five minutes without consuming a rung", async () => {
    const { definition, run, sessionId } = await start({ id: "deferred-rung" });
    await executor.turnEnd();
    executor.states.set(sessionId, { idle: false, runningChildren: 0 });
    await recover("2026-07-21T10:05:00.000Z");
    expect(service.getRun(definition.id, run.id)?.attempts[0]).toMatchObject({
      remindersSent: 0,
      nextReminderAt: "2026-07-21T10:10:00.000Z",
    });
    executor.states.set(sessionId, { idle: true, runningChildren: 1 });
    await recover("2026-07-21T10:10:00.000Z");
    expect(service.getRun(definition.id, run.id)?.attempts[0]).toMatchObject({
      remindersSent: 0,
      nextReminderAt: "2026-07-21T10:15:00.000Z",
    });
    expect(executor.reminders).toEqual([]);
  });

  it("fails with workflow-no-output after rung three and routes the error port", async () => {
    const { definition, run } = await start({ id: "no-output-route", errorRoute: true });
    await sendThreeReminders();
    await executor.turnEnd();

    const detail = service.getRun(definition.id, run.id)!;
    expect(detail.attempts[0]).toMatchObject({
      status: "failed",
      error: { code: "workflow-no-output", retryable: true },
    });
    expect(detail.nodeRuns.find((node) => node.nodeId === "handled")?.status).toBe("completed");
    expect(detail.status).toBe("completed");
  });

  it("does not fail after rung three while delegated children are active", async () => {
    const { definition, run, sessionId } = await start({ id: "children-after-final" });
    await sendThreeReminders();
    executor.states.set(sessionId, { idle: true, runningChildren: 1 });
    await executor.turnEnd();

    expect(service.getRun(definition.id, run.id)?.attempts[0]).toMatchObject({
      status: "running",
      remindersSent: 3,
    });
  });

  it("submits validated success, advances, and rejects a second submission", async () => {
    const output: WorkflowOutputSchema = {
      fields: { result: { type: "string", required: true } },
      allowAdditionalFields: false,
    };
    const { definition, run, sessionId } = await start({ id: "submit-success", output });
    await expect(service.submitAttemptOutput({
      sessionId,
      fields: { result: 42 },
      summary: "Wrong.",
    })).rejects.toBeInstanceOf(WorkflowOutputError);
    expect(service.getRun(definition.id, run.id)?.attempts[0]?.status).toBe("running");

    const completed = await service.submitAttemptOutput({
      sessionId,
      fields: { result: "done" },
      summary: "Finished.",
    });
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed.attempts[0]?.output).toMatchObject({
      text: "Finished.",
      fields: { result: "done" },
      sessionId,
    });
    await expect(service.submitAttemptOutput({ sessionId, fields: { result: "again" } }))
      .rejects.toMatchObject({ code: "already-submitted" } satisfies Partial<WorkflowRepositoryError>);
  });

  it("routes an explicitly submitted failure through the error port", async () => {
    const { definition, run, sessionId } = await start({ id: "submit-failure", errorRoute: true });
    const detail = await service.submitAttemptOutput({
      sessionId,
      outcome: "failure",
      summary: "Could not verify.",
    });

    expect(detail.attempts[0]).toMatchObject({
      status: "failed",
      error: { code: "workflow-submitted-failure", message: "Could not verify." },
    });
    expect(detail.nodeRuns.find((node) => node.nodeId === "handled")?.status).toBe("completed");
    expect(service.getRun(definition.id, run.id)).toEqual(detail);
  });

  it("resets the ladder on extension, records the reason, and starts a fresh five-minute cycle", async () => {
    const { definition, run, sessionId } = await start({ id: "extend-deadline" });
    await executor.turnEnd();
    await recover("2026-07-21T10:05:00.000Z");
    await service.extendAttemptDeadline({ sessionId, reason: "Waiting for a reviewer." });
    expect(service.getRun(definition.id, run.id)?.attempts[0]).toMatchObject({
      remindersSent: 0,
      extensions: 1,
      lastExtensionReason: "Waiting for a reviewer.",
    });
    expect(service.getRun(definition.id, run.id)?.attempts[0]?.nextReminderAt).toBeUndefined();

    await executor.turnEnd();
    expect(service.getRun(definition.id, run.id)?.attempts[0]?.nextReminderAt)
      .toBe("2026-07-21T10:10:00.000Z");
  });

  it("settles a valid fenced block and carries an invalid block error into the next reminder", async () => {
    const output: WorkflowOutputSchema = {
      fields: { score: { type: "number", required: true } },
      allowAdditionalFields: false,
    };
    const valid = await start({ id: "valid-fallback", output });
    await executor.turnEnd("Done.\n```jinn-output\n{\"score\":9}\n```");
    expect(service.getRun(valid.definition.id, valid.run.id)?.attempts[0]).toMatchObject({ status: "completed" });

    const invalid = await start({ id: "invalid-fallback", output });
    await executor.turnEnd("Done.\n```jinn-output\n{\"score\":\"high\"}\n```");
    expect(service.getRun(invalid.definition.id, invalid.run.id)?.attempts[0]).toMatchObject({
      status: "running",
      pendingOutputError: expect.stringContaining('"score"'),
      nextReminderAt: "2026-07-21T10:05:00.000Z",
    });
    await recover("2026-07-21T10:05:00.000Z");
    expect(executor.reminders.at(-1)?.text).toContain("Your previous output block was invalid:");
    expect(executor.reminders.at(-1)?.text).toContain('"score"');
    expect(service.getRun(invalid.definition.id, invalid.run.id)?.attempts[0]?.pendingOutputError).toBeUndefined();
  });

  it("keeps the first tool submission when the same turn later ends with a fenced block", async () => {
    const output: WorkflowOutputSchema = {
      fields: { result: { type: "string", required: true } },
      allowAdditionalFields: false,
    };
    const { definition, run, sessionId } = await start({ id: "tool-before-block", output });
    await service.submitAttemptOutput({ sessionId, fields: { result: "tool" } });
    await executor.turnEnd("```jinn-output\n{\"result\":\"block\"}\n```");

    expect(service.getRun(definition.id, run.id)?.attempts[0]?.output?.fields).toEqual({ result: "tool" });
  });
});
