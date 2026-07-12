import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowRun } from "../../workflows/run-store.js";
import type { WorkflowReportingContext } from "../../workflows/reporting.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-report-reliability-"));
const evidenceRoot = path.join(home, "workflow-evidence");
process.env.JINN_HOME = home;

type Registry = typeof import("../../sessions/registry.js");
type Reporting = typeof import("../../workflows/reporting.js");
type RunStore = typeof import("../../workflows/run-store.js");

let registry: Registry;
let reporting: Reporting;
let runStore: RunStore;

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

function createSession(id: string) {
  const created = registry.createSession({
    engine: "stub",
    source: "web",
    sourceRef: `web:${id}`,
    sessionKey: `web:${id}`,
    connector: "web",
    prompt: id,
  });
  registry.initDb().prepare("UPDATE sessions SET id = ? WHERE id = ?").run(id, created.id);
  return registry.getSession(id)!;
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
  registry = await import("../../sessions/registry.js");
  reporting = await import("../../workflows/reporting.js");
  runStore = await import("../../workflows/run-store.js");
  registry.initDb();
});

beforeEach(() => {
  registry.__closeDbForTest();
  fs.rmSync(path.join(home, "sessions"), { recursive: true, force: true });
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  registry.initDb();
});

describe("Workflow report reliability through shared Session delivery", () => {
  it("collapses six producers into one accepted row, notification, queue item, block, and resume", async () => {
    const session = createSession("invoking-session");
    const run = completedRun(session.id);
    let resumes = 0;
    const reportingContext = context(session.id, () => { resumes++; });
    await Promise.all(Array.from({ length: 6 }, async () => {
      reporting.projectWorkflowRunActivity(run, reportingContext);
    }));
    await settleDeliveryMicrotasks();

    expect(registry.initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 1 });
    expect(registry.listDeadLetterSessionDeliveries()).toHaveLength(0);
    expect(registry.getMessages(session.id).filter((message) => message.role === "notification")).toHaveLength(1);
    expect(registry.listAllPendingQueueItems()).toHaveLength(1);
    expect(resumes).toBe(1);
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
    const target = registry.getSession(session.id)!;
    let resumes = 0;
    let first = true;
    const reportingContext: WorkflowReportingContext = {
      ...context(session.id, () => { resumes++; }),
      deliverClaimed: async (deliveryId) => {
        const accepted = registry.acceptSessionDelivery(deliveryId, session.id, target.sessionKey);
        if (accepted.accepted) resumes++;
        if (first) {
          first = false;
          throw new Error("response lost after acceptance");
        }
        return "accepted";
      },
    };

    reporting.projectWorkflowRunActivity(run, reportingContext);
    await settleDeliveryMicrotasks();
    reporting.projectWorkflowRunActivity(run, reportingContext);
    await settleDeliveryMicrotasks();

    expect(registry.getMessages(session.id).filter((message) => message.role === "notification")).toHaveLength(1);
    expect(registry.listAllPendingQueueItems()).toHaveLength(1);
    expect(registry.getSessionDelivery(registry.listPendingSessionDeliveries()[0]?.id ?? "missing")).toBeUndefined();
    expect(resumes).toBe(1);
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
