import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowSessionProvenance } from "../../shared/types.js";
import type { SessionManager } from "../manager.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-attempt-recovery-"));
process.env.JINN_HOME = home;
const dbModule = await import("../../shared/db.js");

type Registry = typeof import("../registry.js");
type ExecutorModule = typeof import("../../workflows/session-executor.js");

let registry: Registry;
let executorModule: ExecutorModule;

function provenance(runId: string): WorkflowSessionProvenance {
  return {
    kind: "phase",
    workflowId: "release-flow",
    workflowName: "Release flow",
    runId,
    triggerSource: "manual",
    phase: { nodeId: "build", name: "Build", index: 1, round: 1, attempt: 1 },
  };
}

function createPhaseSession(runId: string) {
  const key = `workflow:release-flow:${runId}:build:1`;
  return registry.createSession({
    engine: "test-engine",
    source: "workflow",
    sourceRef: key,
    connector: "workflow",
    sessionKey: key,
    employee: "worker",
    workflowProvenance: provenance(runId),
  });
}

beforeAll(async () => {
  registry = await import("../registry.js");
  executorModule = await import("../../workflows/session-executor.js");
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

afterAll(() => {
  dbModule.__closeDbForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("workflow attempt restart recovery", () => {
  it("settles only orphaned running phase attempts and cancels their internal dispatches", () => {
    const orphaned = createPhaseSession("run-orphaned");
    registry.updateSession(orphaned.id, {
      status: "running",
      attemptTurn: 0,
      attemptInterruptionCause: "user-message",
      attemptInterruptionTurn: 1,
    });
    const runningDispatch = registry.enqueueQueueItem(
      orphaned.id,
      orphaned.sessionKey,
      "Continue the attempt.",
      { internal: true },
    );
    const pendingDispatch = registry.enqueueQueueItem(
      orphaned.id,
      orphaned.sessionKey,
      "Continue the attempt again.",
      { internal: true },
    );
    expect(registry.markQueueItemRunning(runningDispatch)).toBe(true);

    const idle = createPhaseSession("run-idle");
    const withOutcome = createPhaseSession("run-outcome");
    registry.updateSession(withOutcome.id, {
      status: "running",
      attemptOutcome: "failed",
      attemptTerminalVersion: 0,
      attemptTurn: 1,
    });
    const withTerminalVersion = createPhaseSession("run-terminal-version");
    registry.updateSession(withTerminalVersion.id, {
      status: "running",
      attemptTerminalVersion: 2,
    });
    const ordinary = registry.createSession({
      engine: "test-engine",
      source: "web",
      sourceRef: "ordinary-session",
      sessionKey: "ordinary-session",
    });
    registry.updateSession(ordinary.id, { status: "running" });

    expect(registry.recoverStaleWorkflowAttemptSessions()).toBe(1);

    expect(registry.getSession(orphaned.id)).toMatchObject({
      status: "interrupted",
      attemptOutcome: "interrupted",
      attemptTerminalVersion: 1,
      attemptTurn: 1,
      attemptInterruptionCause: null,
      attemptInterruptionTurn: null,
      lastError: expect.stringMatching(/gateway restart/i),
    });
    expect(registry.getQueueItem(runningDispatch)?.status).toBe("cancelled");
    expect(registry.getQueueItem(pendingDispatch)?.status).toBe("cancelled");

    expect(registry.getSession(idle.id)).toMatchObject({
      status: "idle",
      attemptOutcome: null,
      attemptTerminalVersion: 0,
    });
    expect(registry.getSession(withOutcome.id)).toMatchObject({
      status: "running",
      attemptOutcome: "failed",
      attemptTerminalVersion: 0,
    });
    expect(registry.getSession(withTerminalVersion.id)).toMatchObject({
      status: "running",
      attemptOutcome: null,
      attemptTerminalVersion: 2,
    });
    expect(registry.getSession(ordinary.id)).toMatchObject({
      status: "running",
      attemptOutcome: null,
      attemptTerminalVersion: 0,
    });

    expect(registry.recoverStaleSessions()).toBe(1);
    expect(registry.getSession(ordinary.id)).toMatchObject({
      status: "interrupted",
      attemptOutcome: "interrupted",
      attemptTerminalVersion: 1,
    });

    const executor = new executorModule.WorkflowSessionExecutor(
      {} as SessionManager,
      (sessionId) => {
        const session = registry.getSession(sessionId);
        return session ? { session } : null;
      },
    );
    expect(executor.readTerminalCompletion(orphaned.id)).toMatchObject({
      outcome: "interrupted",
      terminalVersion: 1,
      turn: 1,
      interruptionCause: "attempt-stop",
    });
  });
});
