import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  Employee,
  Engine,
  EngineResult,
  EngineRunOpts,
  JinnConfig,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
} from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-attempt-turns-"));
process.env.JINN_HOME = home;

type Registry = typeof import("../registry.js");
type ManagerModule = typeof import("../manager.js");

let registry: Registry;
let managerModule: ManagerModule;

const employee: Employee = {
  name: "worker",
  displayName: "Worker",
  department: "operations",
  rank: "employee",
  engine: "test-engine",
  model: "test-model",
  persona: "Complete the assigned workflow step.",
};

const command: WorkflowAttemptCommand = {
  owner: { workflowId: "content-flow", runId: "run-1", nodeId: "draft", attempt: 1 },
  employeeId: employee.name,
  engine: employee.engine,
  model: employee.model,
  effort: "high",
  prompt: "Draft the release.",
};

function config(): JinnConfig {
  return {
    gateway: { host: "127.0.0.1", port: 7799 },
    engines: {
      default: "test-engine",
      "test-engine": { bin: process.execPath, model: "test-model", effortLevel: "high" },
    },
    models: {
      "test-engine": {
        default: "test-model",
        models: [{ id: "test-model", label: "Test model" }],
      },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
    sessions: {},
    mcp: {},
    portal: { setupComplete: true },
  } as unknown as JinnConfig;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !check(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

function managerWith(runs: EngineRunOpts[]) {
  const engine: Engine = {
    name: "test-engine",
    async run(options) {
      runs.push(options);
      return { sessionId: "engine-session", result: `Turn ${runs.length} complete.` };
    },
  };
  return new managerModule.SessionManager(
    config(),
    new Map([[engine.name, engine]]),
    "test-boot",
    (id) => id === employee.name ? employee : undefined,
  );
}

beforeAll(async () => {
  registry = await import("../registry.js");
  managerModule = await import("../manager.js");
  registry.initDb();
});

beforeEach(() => {
  registry.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("workflow attempt per-turn completion", () => {
  it("persists workflow-dispatched streaming activity while the turn is running", async () => {
    const runs: EngineRunOpts[] = [];
    let resolveTurn!: (result: EngineResult) => void;
    const turn = new Promise<EngineResult>((resolve) => { resolveTurn = resolve; });
    const engine: Engine = {
      name: "test-engine",
      async run(options) {
        runs.push(options);
        options.onStream?.({ type: "text", content: "Inspecting the workspace." });
        options.onStream?.({ type: "tool_use", content: "Search", toolName: "Search", toolId: "search-1" });
        options.onStream?.({ type: "tool_result", content: "Found it.", toolName: "Search", toolId: "search-1" });
        return turn;
      },
    };
    const manager = new managerModule.SessionManager(
      config(),
      new Map([[engine.name, engine]]),
      "test-boot",
      (id) => id === employee.name ? employee : undefined,
    );

    const { sessionId } = await manager.runWorkflowAttempt(command);
    await waitFor(() => runs.length === 1);
    const liveRows = registry.getPartialMessages(sessionId);

    resolveTurn({ sessionId: "engine-session", result: "Turn complete." });
    await waitFor(() => registry.getSession(sessionId)?.status === "idle");

    expect(liveRows).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Inspecting the workspace.",
        partial: true,
      }),
      expect.objectContaining({
        role: "assistant",
        content: "Used Search",
        partial: true,
        toolCall: "Search",
        toolId: "search-1",
      }),
    ]);
    expect(registry.getMessages(sessionId).map((message) => ({
      content: message.content,
      partial: message.partial === true,
      toolCall: message.toolCall,
    }))).toEqual([
      { content: "Draft the release.", partial: false, toolCall: undefined },
      { content: "Inspecting the workspace.", partial: false, toolCall: undefined },
      { content: "Used Search", partial: false, toolCall: "Search" },
      { content: "Turn complete.", partial: false, toolCall: undefined },
    ]);
  });

  it("keeps a durable reminder pending across a crash before in-memory queue attachment", async () => {
    const runs: EngineRunOpts[] = [];
    const manager = managerWith(runs);
    const { sessionId } = await manager.runWorkflowAttempt(command);
    await waitFor(() => runs.length === 1 && registry.getSession(sessionId)?.attemptTurn === 1
      && registry.getSession(sessionId)?.status === "idle");

    await manager.remindWorkflowAttempt(sessionId, "Durable reminder.");
    const pendingBeforeAttachment = registry.listPendingWorkflowAttemptDispatches();
    await waitFor(() => runs.length === 2);

    expect(pendingBeforeAttachment).toEqual([
      expect.objectContaining({ sessionId, status: "pending", prompt: "Durable reminder." }),
    ]);
  });

  it("recovers a pending reminder once after a crash following its durable claim", async () => {
    const runs: EngineRunOpts[] = [];
    const manager = managerWith(runs);
    const { sessionId } = await manager.runWorkflowAttempt(command);
    await waitFor(() => runs.length === 1 && registry.getSession(sessionId)?.attemptTurn === 1
      && registry.getSession(sessionId)?.status === "idle");

    const session = registry.getSession(sessionId)!;
    const claim = registry.claimWorkflowAttemptDispatch(session.id, session.sessionKey, "Recovered reminder.");
    expect(claim).not.toBeNull();

    managerWith(runs);
    managerWith(runs);
    await waitFor(() => runs.length === 2);

    expect(runs).toHaveLength(2);
    expect(registry.getQueueItem(claim!)?.status).toBe("completed");
    expect(registry.getSession(sessionId)).toMatchObject({ status: "idle", attemptTurn: 2 });
  });

  it("emits one completion for every consecutive turn on the same attempt session", async () => {
    const runs: EngineRunOpts[] = [];
    const manager = managerWith(runs);
    const events: WorkflowAttemptCompletion[] = [];
    manager.subscribeWorkflowAttemptCompletion((event) => { events.push(event); });

    const { sessionId } = await manager.runWorkflowAttempt(command);
    await waitFor(() => events.length === 1);
    await manager.remindWorkflowAttempt(sessionId, "Workflow reminder.");
    await waitFor(() => events.length === 2);

    expect(events.map(({ turn, terminalVersion, finalText }) => ({ turn, terminalVersion, finalText }))).toEqual([
      { turn: 1, terminalVersion: 1, finalText: "Turn 1 complete." },
      { turn: 2, terminalVersion: 1, finalText: "Turn 2 complete." },
    ]);
    expect(registry.getSession(sessionId)).toMatchObject({
      status: "idle",
      attemptTurn: 2,
      attemptTerminalVersion: 1,
    });
    expect(runs).toHaveLength(2);
  });

  it("recovers a same-turn explicit stop as attempt-stop even when a user marker was written first", async () => {
    const runs: EngineRunOpts[] = [];
    let resolveTurn!: (result: EngineResult) => void;
    const turn = new Promise<EngineResult>((resolve) => { resolveTurn = resolve; });
    const engine: Engine = {
      name: "test-engine",
      async run(options) {
        runs.push(options);
        return turn;
      },
    };
    const manager = new managerModule.SessionManager(
      config(),
      new Map([[engine.name, engine]]),
      "test-boot",
      (id) => id === employee.name ? employee : undefined,
    );

    const { sessionId } = await manager.runWorkflowAttempt(command);
    await waitFor(() => runs.length === 1);

    // The API marks the in-flight turn as user-interrupted, then an explicit
    // stop takes ownership of the SAME turn before the killed engine settles.
    const live = registry.getSession(sessionId)!;
    registry.updateSession(sessionId, {
      attemptInterruptionCause: "user-message",
      attemptInterruptionTurn: (live.attemptTurn ?? 0) + 1,
    });
    const stopped = registry.interruptSessionAttempt(sessionId, "Workflow run cancelled.", new Date().toISOString());
    expect(stopped).toBeDefined();

    // Crash before the completion listener ran: recovery must classify the
    // durable receipt as attempt-stop, not the stale same-turn user marker.
    const { WorkflowSessionExecutor } = await import("../../workflows/session-executor.js");
    const executor = new WorkflowSessionExecutor(
      manager,
      (id) => { const session = registry.getSession(id); return session ? { session } : null; },
    );
    const completion = executor.readTerminalCompletion(sessionId);
    expect(completion).toMatchObject({ outcome: "interrupted", interruptionCause: "attempt-stop" });
    expect(registry.getSession(sessionId)).toMatchObject({
      attemptInterruptionCause: null,
      attemptInterruptionTurn: null,
    });

    resolveTurn({ sessionId: "engine-session", result: "Late success must not settle." });
    expect(registry.getSession(sessionId)?.attemptOutcome).toBe("interrupted");
  });

  it("reports queue-idle state and counts only active child sessions", async () => {
    const runs: EngineRunOpts[] = [];
    const manager = managerWith(runs);
    const { sessionId } = await manager.runWorkflowAttempt(command);
    await waitFor(() => registry.getSession(sessionId)?.status === "idle");
    await waitFor(() => manager.workflowAttemptState(sessionId)?.idle === true);

    const running = registry.createSession({
      engine: "test-engine",
      source: "web",
      sourceRef: "child-running",
      sessionKey: "child-running",
      parentSessionId: sessionId,
    });
    registry.updateSession(running.id, { status: "running" });
    registry.createSession({
      engine: "test-engine",
      source: "web",
      sourceRef: "child-idle",
      sessionKey: "child-idle",
      parentSessionId: sessionId,
    });
    const queued = registry.createSession({
      engine: "test-engine",
      source: "web",
      sourceRef: "child-queued",
      sessionKey: "child-queued",
      parentSessionId: sessionId,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const queuedTurn = manager.getQueue().enqueue(queued.sessionKey, () => held);
    await waitFor(() => manager.getQueue().isRunning(queued.sessionKey));

    expect(manager.workflowAttemptState(sessionId)).toEqual({ idle: true, runningChildren: 2 });
    expect(manager.workflowAttemptState("missing")).toBeNull();

    release();
    await queuedTurn;
  });
});
