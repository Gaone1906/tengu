import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineRunOpts } from "../../shared/types.js";
import type { WorkflowRun } from "../../workflows/run-store.js";
import type { WorkflowReportingContext } from "../../workflows/reporting.js";
import type { StepSessionProbe } from "../../workflows/advance.js";
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type StepNodeOptions,
  type WorkflowNode,
} from "../../workflows/definition.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-report-reliability-"));
const evidenceRoot = path.join(home, "workflow-evidence");
process.env.JINN_HOME = home;

type Registry = typeof import("../../sessions/registry.js");
type Reporting = typeof import("../../workflows/reporting.js");
type RunStore = typeof import("../../workflows/run-store.js");
type Reconciler = typeof import("../../workflows/run-reconciler.js");
type Api = typeof import("../api.js");
type Callbacks = typeof import("../../sessions/callbacks.js");
type Queue = typeof import("../../sessions/queue.js");
type Advance = typeof import("../../workflows/advance.js");

let registry: Registry;
let reporting: Reporting;
let runStore: RunStore;
let reconciler: Reconciler;
let api: Api;
let callbacks: Callbacks;
let queueModule: Queue;
let advance: Advance;
const processFetch = globalThis.fetch;

function completedRun(sessionId: string, reportMode: "resume" | "silent" = "resume"): WorkflowRun {
  return {
    schemaVersion: 3,
    revision: 7,
    runId: "run-report-reliable",
    workflowId: "release-review",
    definitionVersion: 1,
    title: "Release review",
    trigger: { source: "manual", event: "workflow.manual_started", payload: {} },
    invocation: { sessionId, reportMode },
    reportSequence: 1,
    reportEpisodes: [{
      sequence: 1,
      token: "run-report-reliable:terminal:1",
      kind: "terminal",
      outcome: "completed",
      createdAt: "2026-07-12T01:05:00.000Z",
      summary: "",
    }],
    status: "completed",
    startedAt: "2026-07-12T01:00:00.000Z",
    endedAt: "2026-07-12T01:05:00.000Z",
    steps: ["prepare", "review", "release"].map((nodeId, index) => ({
      nodeId,
      label: nodeId,
      actor: { kind: "employee" as const, ref: `worker-${index}` },
      status: "done" as const,
      outcome: { sessionId: `session-${index}`, summary: "", finalMessage: "", extractedFrom: "final-message" as const },
      at: "2026-07-12T01:04:00.000Z",
    })),
    parked: null,
    order: ["prepare", "review", "release"],
  };
}

function createSession(
  id: string,
  metadata: {
    source?: string;
    connector?: string;
    employee?: string;
    title?: string;
    transportMeta?: Record<string, string | number>;
  } = {},
) {
  const source = metadata.source ?? "web";
  const created = registry.createSession({
    engine: "stub",
    source,
    sourceRef: `${source}:${id}`,
    sessionKey: `${source}:${id}`,
    connector: metadata.connector ?? source,
    employee: metadata.employee,
    title: metadata.title,
    transportMeta: metadata.transportMeta,
    prompt: id,
  });
  registry.initDb().prepare("UPDATE sessions SET id = ? WHERE id = ?").run(id, created.id);
  return registry.getSession(id)!;
}

function createLegacyWorkflowSession(id: string) {
  const created = registry.createSession({
    engine: "workflow",
    source: "web",
    sourceRef: `workflow-run:${id}:legacy`,
    sessionKey: `workflow-run:${id}:legacy`,
    connector: "web",
    prompt: "historical projection",
    workflowProvenance: {
      kind: "run",
      workflowId: "historical-workflow",
      workflowName: "historical-workflow",
      runId: id,
      triggerSource: "manual",
    },
  });
  registry.initDb().prepare("UPDATE sessions SET id = ? WHERE id = ?").run(id, created.id);
  return registry.getSession(id)!;
}

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: Buffer | string) {
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

function makeEngine(seenPrompts: string[]): Engine {
  return {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      seenPrompts.push(opts.prompt);
      return { sessionId: `stub-${seenPrompts.length}`, result: `ack ${seenPrompts.length}` };
    },
  };
}

function makeApiContext(engine: Engine, queue: InstanceType<Queue["SessionQueue"]>) {
  const config = {
    gateway: {},
    engines: { default: "stub", stub: {} },
    sessions: {},
    mcp: {},
  };
  return {
    config,
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => undefined,
    sessionManager: {
      getEngine: () => engine,
      getEngines: () => new Map([["stub", engine]]),
      getQueue: () => queue,
    },
  } as unknown as import("../api.js").ApiContext;
}

function routeBackedFetch(
  context: import("../api.js").ApiContext,
  options: { failBefore?: number; throwAfterAccepted?: number } = {},
) {
  let calls = 0;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (calls <= (options.failBefore ?? 0)) throw new Error("simulated pre-accept response loss");
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const req = Object.assign(Readable.from([Buffer.from(String(init?.body ?? ""))]), {
      method: init?.method ?? "GET",
      url: `${target.pathname}${target.search}`,
      headers: {
        host: "gateway.test",
        authorization: "Bearer test-token",
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const captured = makeResponse();
    await api.handleApiRequest(
      req as unknown as Parameters<Api["handleApiRequest"]>[0],
      captured.res,
      context,
    );
    if (calls <= (options.throwAfterAccepted ?? 0)) throw new Error("simulated post-accept response loss");
    return {
      ok: captured.status >= 200 && captured.status < 300,
      status: captured.status,
      json: async () => captured.body,
    } as Response;
  });
}

async function eventually(assertion: () => void, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function inlineDefinition(id: string): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title: `Workflow ${id.slice(0, 12)}`,
    version: 1,
    status: "active",
    nodes: [
      { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, trigger: { kind: "manual" } },
      { id: "complete", type: "step", label: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [{ id: "edge", from: "trigger", to: "complete", kind: "sequence" }],
  };
}

function actorDefinition(
  id: string,
  nodes: WorkflowNode[] = [{
    id: "work",
    type: "step",
    label: "Work",
    position: { x: 100, y: 0 },
    actor: { kind: "engine", ref: "stub" },
  }],
): EditableWorkflowDefinition {
  const trigger: WorkflowNode = {
    id: "trigger",
    type: "trigger",
    label: "Manual",
    position: { x: 0, y: 0 },
    trigger: { kind: "manual" },
  };
  const all = [trigger, ...nodes];
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title: `Workflow ${id}`,
    version: 1,
    status: "active",
    nodes: all,
    edges: all.slice(1).map((node, index) => ({
      id: `edge-${index}`,
      from: all[index].id,
      to: node.id,
      kind: "sequence" as const,
    })),
  };
}

function actorStep(id: string, options?: StepNodeOptions): WorkflowNode {
  return {
    id,
    type: "step",
    label: id,
    position: { x: 100, y: 0 },
    actor: { kind: "engine", ref: "stub" },
    ...(options ? { options } : {}),
  };
}

function approvalGate(id: string, description: string): WorkflowNode {
  return {
    id,
    type: "gate",
    label: id,
    position: { x: 200, y: 0 },
    gate: { kind: "approval", description, approvalRef: id },
  };
}

function context(sessionId: string, onResume: () => void): WorkflowReportingContext {
  const target = registry.getSession(sessionId)!;
  return {
    sessionExists: (id) => !!registry.getSession(id),
    applyBlock: (id, envelope, fallback) => registry.applyBlockEnvelope(id, envelope, fallback),
    claimDelivery: registry.claimSessionDelivery,
    deliverClaimed: async (deliveryId) => {
      const accepted = registry.acceptSessionDelivery(deliveryId, sessionId, target.sessionKey);
      if (accepted.accepted) onResume();
      return accepted.accepted ? "accepted" : "duplicate";
    },
  };
}

async function settleDeliveryMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  [registry, reporting, runStore, reconciler, api, callbacks, queueModule, advance] = await Promise.all([
    import("../../sessions/registry.js"),
    import("../../workflows/reporting.js"),
    import("../../workflows/run-store.js"),
    import("../../workflows/run-reconciler.js"),
    import("../api.js"),
    import("../../sessions/callbacks.js"),
    import("../../sessions/queue.js"),
    import("../../workflows/advance.js"),
  ]);
  registry.initDb();
});

beforeEach(() => {
  registry.__closeDbForTest();
  fs.rmSync(path.join(home, "sessions"), { recursive: true, force: true });
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  const database = registry.initDb();
  const databaseFile = (database.pragma("database_list") as Array<{ file: string }>)[0]?.file;
  expect(databaseFile).toBe(path.join(fs.realpathSync(home), "sessions", "registry.db"));
  database.exec("DELETE FROM callback_deliveries; DELETE FROM queue_items; DELETE FROM messages; DELETE FROM sessions;");
});

afterEach(() => {
  callbacks.__resetCallbackRetrySweepForTest();
  vi.useRealTimers();
  globalThis.fetch = processFetch;
});

describe("Workflow report reliability through shared Session delivery", () => {
  it.each(["resume", "silent"] as const)(
    "delivers and projects a max-length Workflow id through the real driver, block store, worker, and HTTP acceptance in %s mode",
    async (reportMode) => {
      const session = createSession(`max-id-${reportMode}`);
      const workflowId = `w${"x".repeat(63)}`;
      const definition = inlineDefinition(workflowId);
      const seenPrompts: string[] = [];
      const queue = new queueModule.SessionQueue();
      const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
      globalThis.fetch = routeBackedFetch(apiContext) as unknown as typeof fetch;
      const deps: import("../../workflows/run-reconciler.js").RunDriverDeps = {
        root: evidenceRoot,
        getDefinition: () => definition,
        probeStepSession: () => ({ found: false }),
        spawnStep: async () => ({ sessionId: "unused" }),
        now: () => "2026-07-12T01:00:00.000Z",
        reporting: api.workflowReportingContext(apiContext),
      };

      const run = await reconciler.startWorkflowRun(deps, definition, {
        invocation: { sessionId: session.id, reportMode },
        makeRunId: () => "run-max-valid-workflow-id",
      });

      expect(run.status).toBe("completed");
      await eventually(() => {
        const blocks = registry.getMessages(session.id).flatMap((message) => message.blocks ?? []);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].id.length).toBeLessThanOrEqual(96);
        expect(blocks[0]).toMatchObject({
          type: "workflow-run",
          payload: {
            workflowId,
            runId: run.runId,
            openPath: `/workflow/${workflowId}?mode=runs&run=${run.runId}`,
          },
        });
        const deliveries = registry.initDb().prepare("SELECT status FROM callback_deliveries").all() as Array<{ status: string }>;
        if (reportMode === "silent") {
          expect(deliveries).toHaveLength(0);
          expect(seenPrompts).toHaveLength(0);
        } else {
          expect(deliveries).toEqual([{ status: "accepted" }]);
          expect(registry.listDeadLetterSessionDeliveries()).toHaveLength(0);
          expect(seenPrompts).toHaveLength(1);
        }
      });
    },
  );

  it("reconstructs and delivers a max-length Workflow id after restart through the real recovery and worker path", async () => {
    const session = createSession("max-id-restart");
    const workflowId = `r${"y".repeat(63)}`;
    const definition = inlineDefinition(workflowId);
    const noProjection: WorkflowReportingContext = {
      sessionExists: () => false,
      applyBlock: () => undefined,
      claimDelivery: registry.claimSessionDelivery,
      deliverClaimed: async () => undefined,
    };
    const deps: import("../../workflows/run-reconciler.js").RunDriverDeps = {
      root: evidenceRoot,
      getDefinition: () => definition,
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => ({ sessionId: "unused" }),
      now: () => "2026-07-12T01:00:00.000Z",
      reporting: noProjection,
    };
    const run = await reconciler.startWorkflowRun(deps, definition, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-restart-max-valid-id",
    });
    expect(registry.initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 1 });
    registry.initDb().exec("DELETE FROM callback_deliveries; DELETE FROM messages; DELETE FROM queue_items;");

    const seenPrompts: string[] = [];
    const queue = new queueModule.SessionQueue();
    const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
    globalThis.fetch = routeBackedFetch(apiContext) as unknown as typeof fetch;
    const reportingContext = api.workflowReportingContext(apiContext);
    expect(reporting.recoverWorkflowRunReporting(evidenceRoot, reportingContext)).toMatchObject({ runs: 1, claims: 1 });
    await callbacks.recoverSessionDeliveryStateOnStartup();

    await eventually(() => {
      expect(registry.getMessages(session.id).flatMap((message) => message.blocks ?? [])).toHaveLength(1);
      expect(registry.initDb().prepare("SELECT status FROM callback_deliveries").get()).toEqual({ status: "accepted" });
      expect(seenPrompts).toHaveLength(1);
    });
    expect(run.workflowId).toBe(workflowId);
  });

  it("uses byte-equivalent default-resume reports for ordinary and root/COO invoking Sessions", async () => {
    const ordinary = createSession("ordinary-invoker", {
      source: "slack",
      connector: "slack",
      employee: "a-lead",
      title: "Ordinary department lead",
      transportMeta: { rank: "senior", channel: "department-room" },
    });
    const coo = createSession("root-coo-invoker", {
      source: "web",
      connector: "web",
      employee: "jimbo",
      title: "Root COO",
      transportMeta: { rank: "executive", surface: "root" },
    });
    expect(ordinary).toMatchObject({
      employee: "a-lead",
      source: "slack",
      connector: "slack",
      transportMeta: { rank: "senior", channel: "department-room" },
    });
    expect(coo).toMatchObject({
      employee: "jimbo",
      source: "web",
      connector: "web",
      transportMeta: { rank: "executive", surface: "root" },
    });
    const definition = inlineDefinition("role-agnostic-report");
    const seenPrompts: string[] = [];
    const queue = new queueModule.SessionQueue();
    const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
    globalThis.fetch = routeBackedFetch(apiContext) as unknown as typeof fetch;

    for (const [label, session] of [["ordinary", ordinary], ["coo", coo]] as const) {
      await reconciler.startWorkflowRun({
        root: path.join(evidenceRoot, label),
        getDefinition: () => definition,
        probeStepSession: () => ({ found: false }),
        spawnStep: async () => ({ sessionId: "unused" }),
        now: () => "2026-07-12T01:00:00.000Z",
        reporting: api.workflowReportingContext(apiContext),
      }, definition, {
        invocation: { sessionId: session.id, reportMode: "resume" },
        makeRunId: () => "run-role-parity",
      });
    }

    await eventually(() => expect(seenPrompts).toHaveLength(2));
    const payloads = registry.initDb().prepare(`
      SELECT target_session_id AS targetSessionId, payload
      FROM callback_deliveries
      WHERE source_kind = 'workflow-run'
      ORDER BY target_session_id
    `).all() as Array<{ targetSessionId: string; payload: string }>;
    expect(payloads).toHaveLength(2);
    expect(payloads.map((row) => row.targetSessionId).sort()).toEqual([ordinary.id, coo.id].sort());
    expect(payloads[0].payload).toBe(payloads[1].payload);
  });

  it("projects one correlated block to a distinct acting Session without delivering or waking it", async () => {
    const invocation = createSession("activity-invoker", {
      employee: "workflow-owner",
      transportMeta: { rank: "senior" },
    });
    const acting = createSession("activity-actor", {
      source: "slack",
      connector: "slack",
      employee: "workflow-reviewer",
      transportMeta: { rank: "manager" },
    });
    const run = completedRun(invocation.id);
    const seenPrompts: string[] = [];
    const queue = new queueModule.SessionQueue();
    const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
    globalThis.fetch = routeBackedFetch(apiContext) as unknown as typeof fetch;

    reporting.projectWorkflowRunActivity(run, api.workflowReportingContext(apiContext), acting.id);
    await eventually(() => expect(seenPrompts).toHaveLength(1));

    const invocationBlocks = registry.getMessages(invocation.id).flatMap((message) => message.blocks ?? []);
    const actingBlocks = registry.getMessages(acting.id).flatMap((message) => message.blocks ?? []);
    expect(invocationBlocks).toEqual([expect.objectContaining({
      id: "workflow-run:release-review:run-report-reliable",
    })]);
    expect(actingBlocks).toEqual(invocationBlocks);
    const delivery = registry.initDb().prepare(`
      SELECT target_session_id AS targetSessionId, queue_item_id AS queueItemId
      FROM callback_deliveries WHERE source_kind = 'workflow-run'
    `).get() as { targetSessionId: string; queueItemId: string };
    expect(delivery.targetSessionId).toBe(invocation.id);
    expect(registry.getQueueItem(delivery.queueItemId)).toMatchObject({ sessionId: invocation.id });
    expect(registry.getMessages(invocation.id).filter((message) => message.role === "notification")).toHaveLength(1);
    expect(registry.getMessages(acting.id).filter((message) => message.role === "notification")).toHaveLength(0);
  });

  it("drives success, spawn failure, retry, timeout, failure, cancellation, parking, re-entry, and terminal reports through the real driver and worker", async () => {
    const session = createSession("matrix-invoker");
    const seenPrompts: string[] = [];
    const queue = new queueModule.SessionQueue();
    const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
    globalThis.fetch = routeBackedFetch(apiContext) as unknown as typeof fetch;
    const definitions = new Map<string, EditableWorkflowDefinition>();
    const probes = new Map<string, StepSessionProbe>();
    let clock = Date.parse("2026-07-12T01:00:00.000Z");
    const stopped: string[] = [];
    const deps: import("../../workflows/run-reconciler.js").RunDriverDeps = {
      root: evidenceRoot,
      getDefinition: (_root, id) => definitions.get(id) ?? null,
      probeStepSession: (key) => probes.get(key) ?? { found: false },
      spawnStep: async (ctx) => {
        if (ctx.workflowId === "spawn-failure") throw new Error("engine unavailable");
        const key = advance.stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
        const sessionId = `step:${ctx.workflowId}:${ctx.nodeId}:${ctx.attempt}`;
        probes.set(key, { found: true, sessionId, status: "running" });
        return { sessionId };
      },
      stopStepSession: async (ctx) => { stopped.push(ctx.sessionId ?? ctx.sessionKey); },
      now: () => new Date(clock).toISOString(),
      reporting: api.workflowReportingContext(apiContext),
    };
    const add = (definition: EditableWorkflowDefinition) => {
      definitions.set(definition.id, definition);
      return definition;
    };
    const settle = (
      runId: string,
      nodeId: string,
      attempt: number,
      status: StepSessionProbe["status"],
      finalAssistantText?: string | null,
    ) => {
      const key = advance.stepSessionKey(runId, nodeId, attempt, 1);
      probes.set(key, {
        found: true,
        sessionId: probes.get(key)?.sessionId ?? `step:${nodeId}:${attempt}`,
        status,
        ...(status === "idle" ? { finalAssistantText: finalAssistantText ?? "" } : {}),
      });
    };
    const deliveryCount = () => (registry.initDb().prepare(`
      SELECT COUNT(*) AS count FROM callback_deliveries WHERE source_kind = 'workflow-run'
    `).get() as { count: number }).count;

    const success = add(inlineDefinition("blank-success"));
    await reconciler.startWorkflowRun(deps, success, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-blank-success",
    });
    await eventually(() => expect(deliveryCount()).toBe(1));
    const blankPayload = JSON.parse((registry.initDb().prepare(`
      SELECT payload FROM callback_deliveries WHERE source_id = 'blank-success:run-blank-success'
    `).get() as { payload: string }).payload) as { message: string };
    expect(blankPayload.message).toContain(`Workflow "${success.title}" completed.`);
    expect(blankPayload.message).toContain("Completed 1 of 1 phases.");
    expect(blankPayload.message.trim()).not.toBe("");

    const spawnFailure = add(actorDefinition("spawn-failure"));
    const failedAtSpawn = await reconciler.startWorkflowRun(deps, spawnFailure, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-spawn-failure",
    });
    expect(failedAtSpawn.status).toBe("failed");
    await eventually(() => expect(deliveryCount()).toBe(2));

    const spawnRetry = add(actorDefinition("spawn-retry", [actorStep("spawn-retry-step") ]));
    const spawnRetryRun = await reconciler.startWorkflowRun(deps, spawnRetry, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-spawn-retry",
    });
    const spawned = runStore.getRun(evidenceRoot, spawnRetry.id, spawnRetryRun.runId)!;
    const crashed = advance.markDispatching({
      ...spawned,
      steps: spawned.steps.map((receipt) => receipt.nodeId === "spawn-retry-step"
        ? { ...receipt, status: "pending" as const, sessionId: undefined }
        : receipt),
    }, "spawn-retry-step", 1, () => new Date(clock).toISOString());
    runStore.saveRun(evidenceRoot, crashed);
    probes.delete(advance.stepSessionKey(spawnRetryRun.runId, "spawn-retry-step", 1, 1));
    await reconciler.sweepWorkflowRuns(deps);
    expect(runStore.getRun(evidenceRoot, spawnRetry.id, spawnRetryRun.runId)?.status).toBe("running");
    expect(deliveryCount()).toBe(2);
    settle(spawnRetryRun.runId, "spawn-retry-step", 1, "idle", "recovered after spawn retry");
    await reconciler.sweepWorkflowRuns(deps);
    await eventually(() => expect(deliveryCount()).toBe(3));

    const retry = add(actorDefinition("retry-exhaustion", [actorStep("retry", {
      retry: { maxAttempts: 2, on: ["interrupted"] },
    })]));
    const retryRun = await reconciler.startWorkflowRun(deps, retry, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-retry-exhaustion",
    });
    settle(retryRun.runId, "retry", 1, "interrupted");
    await reconciler.sweepWorkflowRuns(deps);
    expect(runStore.getRun(evidenceRoot, retry.id, retryRun.runId)?.status).toBe("running");
    expect(deliveryCount()).toBe(3);
    settle(retryRun.runId, "retry", 2, "interrupted");
    await reconciler.sweepWorkflowRuns(deps);
    await eventually(() => expect(deliveryCount()).toBe(4));

    const timeout = add(actorDefinition("timeout-exhaustion", [actorStep("timeout", {
      timeoutMinutes: 1,
      retry: { maxAttempts: 2, on: ["timeout"] },
    })]));
    const timeoutRun = await reconciler.startWorkflowRun(deps, timeout, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-timeout-exhaustion",
    });
    clock += 61_000;
    await reconciler.sweepWorkflowRuns(deps);
    expect(runStore.getRun(evidenceRoot, timeout.id, timeoutRun.runId)?.status).toBe("running");
    expect(deliveryCount()).toBe(4);
    clock += 61_000;
    await reconciler.sweepWorkflowRuns(deps);
    await eventually(() => expect(deliveryCount()).toBe(5));
    expect(stopped).toHaveLength(2);

    const errorDefinition = add(actorDefinition("step-failure"));
    const errorRun = await reconciler.startWorkflowRun(deps, errorDefinition, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-step-failure",
    });
    settle(errorRun.runId, "work", 1, "error");
    await reconciler.sweepWorkflowRuns(deps);
    await eventually(() => expect(deliveryCount()).toBe(6));

    const cancellation = add(actorDefinition("cancellation"));
    const cancellationRun = await reconciler.startWorkflowRun(deps, cancellation, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-cancellation",
    });
    await reconciler.cancelWorkflowRun(deps, cancellation.id, cancellationRun.runId, {
      actor: "operator",
      reason: "matrix cancellation",
    });
    settle(cancellationRun.runId, "work", 1, "interrupted");
    await reconciler.sweepWorkflowRuns(deps);
    await eventually(() => expect(deliveryCount()).toBe(7));
    expect(runStore.getRun(evidenceRoot, cancellation.id, cancellationRun.runId)?.status).toBe("cancelled");

    const parking = add(actorDefinition("parking-reentry", [
      actorStep("first"),
      approvalGate("gate-one", "Approve first checkpoint"),
      actorStep("second"),
      approvalGate("gate-two", "Approve publication"),
    ]));
    const parkingRun = await reconciler.startWorkflowRun(deps, parking, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-parking-reentry",
    });
    settle(parkingRun.runId, "first", 1, "idle", "first result");
    await reconciler.sweepWorkflowRuns(deps);
    await eventually(() => expect(deliveryCount()).toBe(8));
    let parked = runStore.getRun(evidenceRoot, parking.id, parkingRun.runId)!;
    expect(parked).toMatchObject({
      status: "parked",
      parked: { nodeId: "gate-one", description: "Approve first checkpoint" },
    });
    await reconciler.resolveWorkflowRunGate(deps, parking.id, parkingRun.runId, "approve", { decidedBy: "operator" });
    settle(parkingRun.runId, "second", 1, "idle", "second result");
    await reconciler.sweepWorkflowRuns(deps);
    await eventually(() => expect(deliveryCount()).toBe(9));
    parked = runStore.getRun(evidenceRoot, parking.id, parkingRun.runId)!;
    expect(parked).toMatchObject({ status: "parked", parked: { nodeId: "gate-two", description: "Approve publication" } });
    await reconciler.resolveWorkflowRunGate(deps, parking.id, parkingRun.runId, "approve", { decidedBy: "operator" });
    await eventually(() => expect(deliveryCount()).toBe(10));
    const parkedTerminal = runStore.getRun(evidenceRoot, parking.id, parkingRun.runId)!;
    expect(parkedTerminal.status).toBe("completed");
    expect(parkedTerminal.reportEpisodes?.map(({ kind, outcome, sequence }) => ({ kind, outcome, sequence }))).toEqual([
      { kind: "parked", outcome: "parked", sequence: 1 },
      { kind: "parked", outcome: "parked", sequence: 2 },
      { kind: "terminal", outcome: "completed", sequence: 3 },
    ]);

    await eventually(() => expect(seenPrompts).toHaveLength(10));
    const failureEvidence = [
      ["spawn-failure:run-spawn-failure", /spawn failed: engine unavailable/i],
      ["retry-exhaustion:run-retry-exhaustion", /interrupted.*retry exhausted: 2 attempt/i],
      ["timeout-exhaustion:run-timeout-exhaustion", /exceeded its 1-minute budget on attempt 2/i],
      ["step-failure:run-step-failure", /session ended in error/i],
    ] as const;
    for (const [sourceId, expectedDetail] of failureEvidence) {
      const rows = registry.initDb().prepare(`
        SELECT payload, message_id AS messageId, queue_item_id AS queueItemId
        FROM callback_deliveries
        WHERE source_kind = 'workflow-run' AND source_id = ?
      `).all(sourceId) as Array<{ payload: string; messageId: string; queueItemId: string }>;
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0].payload) as { message: string; displayMessage: string };
      expect(payload.message).toMatch(expectedDetail);
      expect(payload.displayMessage).toBe(payload.message);
      expect(registry.getMessages(session.id).filter((message) => message.id === rows[0].messageId)).toEqual([
        expect.objectContaining({ role: "notification", content: expect.stringMatching(expectedDetail) }),
      ]);
      expect(registry.getQueueItem(rows[0].queueItemId)).toMatchObject({
        sessionId: session.id,
        prompt: expect.stringMatching(expectedDetail),
      });
    }
    expect(registry.listDeadLetterSessionDeliveries()).toHaveLength(0);
  });

  it("keeps a legacy Workflow target read-only through the real driver and shared worker", async () => {
    const legacy = createLegacyWorkflowSession("legacy-report-target");
    const definition = inlineDefinition("legacy-target-report");
    const seenPrompts: string[] = [];
    const queue = new queueModule.SessionQueue();
    const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
    globalThis.fetch = routeBackedFetch(apiContext) as unknown as typeof fetch;
    const deps: import("../../workflows/run-reconciler.js").RunDriverDeps = {
      root: evidenceRoot,
      getDefinition: () => definition,
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => ({ sessionId: "unused" }),
      now: () => "2026-07-12T01:00:00.000Z",
      reporting: api.workflowReportingContext(apiContext),
    };

    await reconciler.startWorkflowRun(deps, definition, {
      invocation: { sessionId: legacy.id, reportMode: "resume" },
      makeRunId: () => "run-legacy-target",
    });
    await settleDeliveryMicrotasks();

    expect(registry.getMessages(legacy.id).flatMap((message) => message.blocks ?? [])).toHaveLength(0);
    expect(registry.listPendingSessionDeliveries()).toEqual([
      expect.objectContaining({ sourceKind: "workflow-run", status: "pending", attemptCount: 0 }),
    ]);
    expect(registry.listDeadLetterSessionDeliveries()).toHaveLength(0);
    expect(seenPrompts).toHaveLength(0);
  });

  it("dead-letters a deleted Workflow target, exposes it through the compatibility API, and requeues it exactly once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T02:00:00.000Z"));
    const session = createSession("deleted-report-target");
    const definition = actorDefinition("deleted-target-report");
    const probes = new Map<string, StepSessionProbe>();
    const seenPrompts: string[] = [];
    const queue = new queueModule.SessionQueue();
    const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
    const routeFetch = routeBackedFetch(apiContext);
    globalThis.fetch = routeFetch as unknown as typeof fetch;
    const deps: import("../../workflows/run-reconciler.js").RunDriverDeps = {
      root: evidenceRoot,
      getDefinition: () => definition,
      probeStepSession: (key) => probes.get(key) ?? { found: false },
      spawnStep: async (ctx) => {
        const key = advance.stepSessionKey(ctx.runId, ctx.nodeId, ctx.attempt, ctx.round);
        probes.set(key, { found: true, sessionId: "deleted-step", status: "running" });
        return { sessionId: "deleted-step" };
      },
      now: () => new Date().toISOString(),
      reporting: api.workflowReportingContext(apiContext),
    };
    const run = await reconciler.startWorkflowRun(deps, definition, {
      invocation: { sessionId: session.id, reportMode: "resume" },
      makeRunId: () => "run-deleted-target",
    });
    expect(registry.deleteSession(session.id)).toBe(true);
    probes.set(advance.stepSessionKey(run.runId, "work", 1, 1), {
      found: true,
      sessionId: "deleted-step",
      status: "idle",
      finalAssistantText: "finished after requester deletion",
    });
    await reconciler.sweepWorkflowRuns(deps);
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of callbacks.CALLBACK_DELIVERY_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.runAllTicks();
    }

    const dead = registry.listDeadLetterSessionDeliveries();
    expect(dead).toEqual([expect.objectContaining({
      sourceKind: "workflow-run",
      targetSessionId: session.id,
      attemptCount: callbacks.CALLBACK_DELIVERY_MAX_ATTEMPTS,
    })]);
    const listed = await routeFetch("http://gateway.test/api/callback-deliveries/dead-letter", { method: "GET" });
    expect(listed.status).toBe(200);
    expect((await listed.json()).deliveries).toEqual([expect.objectContaining({ id: dead[0].id, sourceKind: "workflow-run" })]);

    createSession(session.id);
    const requeued = await routeFetch(`http://gateway.test/api/callback-deliveries/${dead[0].id}/requeue`, { method: "POST" });
    expect(requeued.status).toBe(200);
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTicks();
    expect(registry.getSessionDelivery(dead[0].id)).toMatchObject({ status: "accepted" });
    expect(registry.getMessages(session.id).filter((message) => message.role === "notification")).toHaveLength(1);
    expect(seenPrompts).toHaveLength(1);
  });

  it("collapses six producers into one accepted row, notification, queue item, block, and resume", async () => {
    const session = createSession("invoking-session");
    const run = completedRun(session.id);
    const seenPrompts: string[] = [];
    const queue = new queueModule.SessionQueue();
    const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
    globalThis.fetch = routeBackedFetch(apiContext) as unknown as typeof fetch;
    const reportingContext = api.workflowReportingContext(apiContext);
    await Promise.all(Array.from({ length: 6 }, async () => {
      reporting.projectWorkflowRunActivity(run, reportingContext);
    }));
    await eventually(() => expect(seenPrompts).toHaveLength(1));

    expect(registry.initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 1 });
    expect(registry.listDeadLetterSessionDeliveries()).toHaveLength(0);
    expect(registry.getMessages(session.id).filter((message) => message.role === "notification")).toHaveLength(1);
    expect(registry.initDb().prepare("SELECT queue_item_id AS queueItemId FROM callback_deliveries").get())
      .toEqual({ queueItemId: expect.any(String) });
    expect(registry.listAllPendingQueueItems()).toHaveLength(0);
    expect(registry.getMessages(session.id).flatMap((message) => message.blocks ?? []))
      .toEqual([expect.objectContaining({ id: "workflow-run:release-review:run-report-reliable", status: "completed" })]);
  });

  it("assigns distinct shared-delivery ids to a later park and terminal episode", async () => {
    const session = createSession("episode-identity-session");
    const reportingContext = context(session.id, () => undefined);
    const firstPark: WorkflowRun = {
      ...completedRun(session.id),
      revision: 2,
      status: "parked",
      endedAt: null,
      parked: {
        scope: "runGate",
        nodeId: null,
        kind: "approval",
        evaluator: "human-approval",
        description: "Approve the release candidate",
      },
      reportSequence: 1,
      reportEpisodes: [{
        sequence: 1,
        token: "run-report-reliable:parked:1",
        kind: "parked",
        outcome: "parked",
        createdAt: "2026-07-12T01:02:00.000Z",
        summary: "Approve the release candidate",
      }],
    };
    const secondPark: WorkflowRun = {
      ...firstPark,
      revision: 5,
      parked: { ...firstPark.parked!, description: "Approve publication" },
      reportSequence: 2,
      reportEpisodes: [
        ...firstPark.reportEpisodes!,
        {
          sequence: 2,
          token: "run-report-reliable:parked:2",
          kind: "parked",
          outcome: "parked",
          createdAt: "2026-07-12T01:04:00.000Z",
          summary: "Approve publication",
        },
      ],
    };
    const terminal: WorkflowRun = {
      ...completedRun(session.id),
      reportSequence: 3,
      reportEpisodes: [
        ...secondPark.reportEpisodes!,
        {
          sequence: 3,
          token: "run-report-reliable:terminal:3",
          kind: "terminal",
          outcome: "completed",
          createdAt: "2026-07-12T01:05:00.000Z",
          summary: "Workflow completed",
        },
      ],
    };

    reporting.projectWorkflowRunActivity(firstPark, reportingContext);
    reporting.projectWorkflowRunActivity(secondPark, reportingContext);
    reporting.projectWorkflowRunActivity(terminal, reportingContext);
    await settleDeliveryMicrotasks();

    const deliveries = registry.initDb().prepare(`
      SELECT id, source_attempt AS sourceAttempt, source_outcome AS sourceOutcome
      FROM callback_deliveries
      WHERE source_kind = 'workflow-run'
      ORDER BY source_version
    `).all() as Array<{ id: string; sourceAttempt: string; sourceOutcome: string }>;
    expect(deliveries).toHaveLength(3);
    expect(new Set(deliveries.map((delivery) => delivery.id)).size).toBe(3);
    expect(deliveries.filter((delivery) => delivery.sourceOutcome === "parked")).toHaveLength(2);
    expect(deliveries.filter((delivery) => delivery.sourceOutcome === "completed")).toHaveLength(1);
    expect(deliveries.map((delivery) => delivery.sourceAttempt)).toEqual([
      "run-report-reliable:parked:1",
      "run-report-reliable:parked:2",
      "run-report-reliable:terminal:3",
    ]);
  });

  it("does not duplicate after the acceptance response is lost", async () => {
    const session = createSession("response-loss-session");
    const run = completedRun(session.id);
    const seenPrompts: string[] = [];
    const queue = new queueModule.SessionQueue();
    const apiContext = makeApiContext(makeEngine(seenPrompts), queue);
    const fetchSpy = routeBackedFetch(apiContext, { throwAfterAccepted: 1 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const reportingContext = api.workflowReportingContext(apiContext);

    reporting.projectWorkflowRunActivity(run, reportingContext);
    await eventually(() => expect(seenPrompts).toHaveLength(1));
    reporting.projectWorkflowRunActivity(run, reportingContext);
    await settleDeliveryMicrotasks();

    expect(registry.getMessages(session.id).filter((message) => message.role === "notification")).toHaveLength(1);
    expect(registry.initDb().prepare("SELECT queue_item_id AS queueItemId FROM callback_deliveries").get())
      .toEqual({ queueItemId: expect.any(String) });
    expect(registry.listAllPendingQueueItems()).toHaveLength(0);
    expect(registry.listPendingSessionDeliveries()).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reconstructs a missing terminal claim and block across restart without a duplicate", () => {
    const session = createSession("restart-session");
    const run = completedRun(session.id);
    runStore.saveRun(evidenceRoot, run);

    const first = reporting.recoverWorkflowRunReporting(evidenceRoot, context(session.id, () => undefined));
    expect(first).toMatchObject({ runs: 1, claims: 1 });
    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
    expect(registry.getMessages(session.id).flatMap((message) => message.blocks ?? []))
      .toEqual([expect.objectContaining({ id: "workflow-run:release-review:run-report-reliable" })]);

    registry.__closeDbForTest();
    registry.initDb();
    const second = reporting.recoverWorkflowRunReporting(evidenceRoot, context(session.id, () => undefined));
    expect(second).toMatchObject({ runs: 1, claims: 0 });
    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
  });
});
