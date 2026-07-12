import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatBlockEnvelope, SessionDeliveryIdentity, SessionDeliveryPayload } from "../../shared/types.js";
import type { WorkflowRun, WorkflowRunStatus } from "../run-store.js";
import { getRun } from "../run-store.js";
import { startWorkflowRun, type RunDriverDeps } from "../run-reconciler.js";
import { WORKFLOW_DEFINITION_SCHEMA_VERSION, type EditableWorkflowDefinition } from "../definition.js";
import {
  projectWorkflowRunActivity,
  stampWorkflowRunReportEpisode,
  type WorkflowReportingContext,
} from "../reporting.js";

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    schemaVersion: 3,
    revision: 1,
    runId: "run-report-1",
    workflowId: "release-review",
    definitionVersion: 1,
    title: "Release review",
    trigger: { source: "manual", event: "workflow.manual_started", payload: {} },
    invocation: { sessionId: "invoking-session", reportMode: "resume" },
    status: "running",
    startedAt: "2026-07-12T01:00:00.000Z",
    endedAt: null,
    steps: [],
    parked: null,
    order: [],
    ...overrides,
  };
}

describe("Workflow run report episodes", () => {
  it("stamps one first park, one re-entry park, and one terminal episode", () => {
    const times = [
      "2026-07-12T01:01:00.000Z",
      "2026-07-12T01:02:00.000Z",
      "2026-07-12T01:03:00.000Z",
      "2026-07-12T01:04:00.000Z",
      "2026-07-12T01:05:00.000Z",
      "2026-07-12T01:06:00.000Z",
    ];
    let current = run();

    current = stampWorkflowRunReportEpisode(current, {
      ...current,
      revision: 2,
      status: "parked",
      parked: {
        scope: "runGate",
        nodeId: null,
        kind: "approval",
        evaluator: "human-approval",
        description: "Approve the release",
        at: times[0],
      },
    }, times[0]);
    current = stampWorkflowRunReportEpisode(current, {
      ...current,
      revision: 3,
      parked: { ...current.parked!, description: "Approve the release candidate" },
    }, times[1]);
    current = stampWorkflowRunReportEpisode(current, {
      ...current,
      revision: 4,
      parked: { ...current.parked!, ref: "approval-1" },
    }, times[2]);
    current = stampWorkflowRunReportEpisode(current, {
      ...current,
      revision: 5,
      status: "running",
      parked: null,
    }, times[3]);
    current = stampWorkflowRunReportEpisode(current, {
      ...current,
      revision: 6,
      status: "parked",
      parked: {
        scope: "runGate",
        nodeId: null,
        kind: "approval",
        evaluator: "human-approval",
        description: "Approve publication",
        at: times[4],
      },
    }, times[4]);
    current = stampWorkflowRunReportEpisode(current, {
      ...current,
      revision: 7,
      status: "completed",
      parked: null,
      endedAt: times[5],
    }, times[5]);
    current = stampWorkflowRunReportEpisode(current, { ...current, revision: 8 }, times[5]);

    expect(current.reportEpisodes?.map(({ sequence, kind, token }) => ({ sequence, kind, token }))).toEqual([
      { sequence: 1, kind: "parked", token: `${current.runId}:parked:1` },
      { sequence: 2, kind: "parked", token: `${current.runId}:parked:2` },
      { sequence: 3, kind: "terminal", token: `${current.runId}:terminal:3` },
    ]);
    expect(current.reportSequence).toBe(3);
    expect(current.reportEpisodes?.map((episode) => episode.createdAt)).toEqual([times[0], times[4], times[5]]);
  });

  it("projects every run state and claims only stable parked or terminal episodes", () => {
    const rows: Array<{
      status: WorkflowRunStatus;
      blockStatus: "running" | "waiting" | "completed" | "error";
      deliveryKind?: "workflow-parked" | "workflow-terminal";
    }> = [
      { status: "running", blockStatus: "running" },
      { status: "parked", blockStatus: "waiting", deliveryKind: "workflow-parked" },
      { status: "completed", blockStatus: "completed", deliveryKind: "workflow-terminal" },
      { status: "failed", blockStatus: "error", deliveryKind: "workflow-terminal" },
      { status: "cancelled", blockStatus: "error", deliveryKind: "workflow-terminal" },
    ];

    for (const [index, row] of rows.entries()) {
      const claims: Array<SessionDeliveryIdentity & { payload: SessionDeliveryPayload }> = [];
      const blocks: ChatBlockEnvelope[] = [];
      const context: WorkflowReportingContext = {
        sessionExists: () => true,
        applyBlock: (_sessionId, envelope) => blocks.push(envelope),
        emitBlock: () => undefined,
        claimDelivery: (input) => {
          claims.push(input);
          return {
            claimed: true,
            delivery: {
              ...input,
              id: `delivery-${index}`,
              status: "pending",
              messageId: null,
              queueItemId: null,
              attemptCount: 0,
              nextAttemptAt: null,
              lastAttemptAt: null,
              lastError: null,
              deadLetteredAt: null,
              createdAt: "2026-07-12T01:00:00.000Z",
              acceptedAt: null,
            },
          };
        },
        deliverClaimed: () => Promise.resolve("accepted"),
      };
      const episode = row.deliveryKind
        ? {
            sequence: 1,
            token: `run-report-${index}:${row.status === "parked" ? "parked" : "terminal"}:1`,
            kind: row.status === "parked" ? "parked" as const : "terminal" as const,
            outcome: row.status === "parked" ? "parked" as const : row.status as "completed" | "failed" | "cancelled",
            createdAt: "2026-07-12T01:01:00.000Z",
            summary: `${row.status} summary`,
          }
        : undefined;
      const candidate = run({
        runId: `run-report-${index}`,
        revision: index + 2,
        status: row.status,
        endedAt: ["completed", "failed", "cancelled"].includes(row.status)
          ? "2026-07-12T01:02:00.000Z"
          : null,
        parked: row.status === "parked"
          ? {
              scope: "runGate",
              nodeId: null,
              kind: "approval",
              evaluator: "human-approval",
              description: "Approve the release",
            }
          : null,
        ...(episode ? { reportSequence: 1, reportEpisodes: [episode] } : {}),
      });

      projectWorkflowRunActivity(candidate, context);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        op: "put",
        block: {
          id: `workflow-run:release-review:run-report-${index}`,
          type: "workflow-run",
          version: index + 2,
          status: row.blockStatus,
          title: "Release review",
          payload: {
            workflowId: "release-review",
            runId: `run-report-${index}`,
            runStatus: row.status,
            startedAt: "2026-07-12T01:00:00.000Z",
            endedAt: candidate.endedAt,
            completedSteps: 0,
            totalSteps: 0,
            openPath: `/workflow/release-review?mode=runs&run=run-report-${index}`,
          },
        },
      });
      expect(claims).toHaveLength(row.deliveryKind ? 1 : 0);
      if (row.deliveryKind) {
        expect(claims[0]).toMatchObject({
          targetSessionId: "invoking-session",
          sourceKind: "workflow-run",
          sourceId: `release-review:run-report-${index}`,
          sourceAttempt: episode!.token,
          sourceOutcome: row.status,
          sourceVersion: 1,
          deliveryKind: row.deliveryKind,
        });
      }
    }
  });

  it("builds a deterministic nonempty completion report when every phase output is blank", () => {
    const claims: Array<SessionDeliveryIdentity & { payload: SessionDeliveryPayload }> = [];
    const completed = run({
      revision: 9,
      status: "completed",
      endedAt: "2026-07-12T01:05:00.000Z",
      steps: ["prepare", "review", "release"].map((nodeId, index) => ({
        nodeId,
        label: nodeId,
        actor: { kind: "employee" as const, ref: `worker-${index}` },
        status: "done" as const,
        outcome: { sessionId: `session-${index}`, summary: "", finalMessage: "", extractedFrom: "final-message" as const },
        at: "2026-07-12T01:04:00.000Z",
      })),
      reportSequence: 1,
      reportEpisodes: [{
        sequence: 1,
        token: "run-report-1:terminal:1",
        kind: "terminal",
        outcome: "completed",
        createdAt: "2026-07-12T01:05:00.000Z",
        summary: "",
      }],
    });
    projectWorkflowRunActivity(completed, {
      sessionExists: () => true,
      applyBlock: () => undefined,
      claimDelivery: (input) => {
        claims.push(input);
        return { claimed: true, delivery: { ...input, id: "delivery", status: "pending", messageId: null, queueItemId: null, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastError: null, deadLetteredAt: null, createdAt: completed.startedAt, acceptedAt: null } };
      },
      deliverClaimed: () => Promise.resolve("accepted"),
    });

    expect(claims[0].payload.message).toContain('Workflow "Release review" completed.');
    expect(claims[0].payload.message).toContain("Completed 3 of 3 phases.");
    expect(claims[0].payload.message.trim()).not.toBe("");
  });

  it("is role-agnostic and silent mode keeps activity without claiming a callback", () => {
    const episode = {
      sequence: 1,
      token: "run-report-1:parked:1",
      kind: "parked" as const,
      outcome: "parked" as const,
      createdAt: "2026-07-12T01:01:00.000Z",
      summary: "Approve the release",
    };
    const parked = run({
      status: "parked",
      parked: { scope: "runGate", nodeId: null, kind: "approval", evaluator: "human-approval", description: "Approve the release" },
      reportSequence: 1,
      reportEpisodes: [episode],
    });
    const payloads: SessionDeliveryPayload[] = [];
    const makeContext = (): WorkflowReportingContext => ({
      sessionExists: () => true,
      applyBlock: () => undefined,
      claimDelivery: (input) => {
        payloads.push(input.payload);
        return { claimed: true, delivery: { ...input, id: "delivery", status: "pending", messageId: null, queueItemId: null, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastError: null, deadLetteredAt: null, createdAt: parked.startedAt, acceptedAt: null } };
      },
      deliverClaimed: () => Promise.resolve("accepted"),
    });
    projectWorkflowRunActivity(parked, makeContext());
    projectWorkflowRunActivity({ ...parked, invocation: { sessionId: "root-session", reportMode: "resume" } }, makeContext());
    expect(payloads[0]).toEqual(payloads[1]);

    let blockCount = 0;
    let claimCount = 0;
    projectWorkflowRunActivity({ ...parked, invocation: { sessionId: "silent-session", reportMode: "silent" } }, {
      sessionExists: () => true,
      applyBlock: () => { blockCount++; },
      claimDelivery: () => { claimCount++; throw new Error("silent must not claim"); },
      deliverClaimed: () => Promise.resolve("accepted"),
    });
    expect(blockCount).toBe(1);
    expect(claimCount).toBe(0);
  });

  it("saves a parked episode before projecting or claiming it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-report-save-order-"));
    const definition: EditableWorkflowDefinition = {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: "approval-review",
      title: "Approval review",
      version: 1,
      status: "active",
      nodes: [
        { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, trigger: { kind: "manual" } },
        { id: "prepare", type: "step", label: "Prepare", position: { x: 100, y: 0 }, instructions: "Prepare inline" },
        { id: "approval", type: "gate", label: "Approval", position: { x: 200, y: 0 }, gate: { kind: "approval", description: "Approve the release", approvalRef: "release-approval" } },
      ],
      edges: [
        { id: "edge-1", from: "trigger", to: "prepare", kind: "sequence" },
        { id: "edge-2", from: "prepare", to: "approval", kind: "sequence" },
      ],
    };
    let projections = 0;
    let claims = 0;
    const deps: RunDriverDeps = {
      root,
      getDefinition: () => definition,
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => ({ sessionId: "unused" }),
      now: () => "2026-07-12T01:00:00.000Z",
      reporting: {
        sessionExists: () => true,
        applyBlock: () => {
          projections++;
          const persisted = getRun(root, "approval-review", "run-save-order");
          expect(persisted?.reportEpisodes).toHaveLength(1);
          expect(persisted?.status).toBe("parked");
        },
        claimDelivery: (input) => {
          claims++;
          const persisted = getRun(root, "approval-review", "run-save-order");
          expect(persisted?.reportEpisodes?.[0]?.token).toBe(input.sourceAttempt);
          return { claimed: true, delivery: { ...input, id: "delivery", status: "accepted", messageId: "message", queueItemId: "queue", attemptCount: 1, nextAttemptAt: null, lastAttemptAt: 1, lastError: null, deadLetteredAt: null, createdAt: "2026-07-12T01:00:00.000Z", acceptedAt: "2026-07-12T01:00:00.000Z" } };
        },
        deliverClaimed: () => Promise.resolve("accepted"),
      },
    };

    try {
      const result = await startWorkflowRun(deps, definition, {
        invocation: { sessionId: "invoking-session", reportMode: "resume" },
        makeRunId: () => "run-save-order",
      });
      expect(result.errors).toBeUndefined();
      expect(result.status).toBe("parked");
      expect(result.reportEpisodes).toHaveLength(1);
      expect(projections).toBeGreaterThan(0);
      expect(claims).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
