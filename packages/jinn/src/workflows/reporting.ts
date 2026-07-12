import { createHash } from 'node:crypto';
import type {
  WorkflowRun,
  WorkflowRunReportEpisode,
  WorkflowRunStatus,
} from './run-store.js';
import {
  getRun,
  listRuns,
  listRunWorkflowIds,
  WORKFLOW_RUN_SCHEMA_VERSION,
} from './run-store.js';
import type {
  ChatBlockEnvelope,
  SessionDelivery,
  SessionDeliveryIdentity,
  SessionDeliveryPayload,
} from '../shared/types.js';
import { blockFallbackText } from '../shared/blocks.js';

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>(['completed', 'failed', 'cancelled']);

function completedStepCount(run: WorkflowRun): number {
  return run.steps.filter((step) => [
    'done',
    'skipped',
    'inline',
    'checkpoint',
    'routed',
    'fired',
  ].includes(step.status)).length;
}

export interface WorkflowReportingContext {
  sessionExists: (sessionId: string) => boolean;
  applyBlock: (sessionId: string, envelope: ChatBlockEnvelope, fallback: string) => unknown;
  emitBlock?: (sessionId: string, envelope: ChatBlockEnvelope, fallback: string) => void;
  claimDelivery: (
    input: SessionDeliveryIdentity & { payload: SessionDeliveryPayload },
  ) => { delivery: SessionDelivery; claimed: boolean };
  deliverClaimed: (deliveryId: string) => Promise<unknown>;
  log?: (level: 'warn' | 'error', message: string) => void;
}

function episodeSummary(run: WorkflowRun, kind: WorkflowRunReportEpisode['kind']): string {
  if (kind === 'parked') {
    return run.parked?.description?.trim() || `Workflow "${run.title}" is waiting for approval.`;
  }
  if (run.status === 'completed') {
    return `Workflow "${run.title}" completed. Completed ${completedStepCount(run)} of ${run.steps.length} phases.`;
  }
  if (run.status === 'cancelled') return `Workflow "${run.title}" was cancelled.`;
  const latest = run.errors?.at(-1)?.message?.trim();
  return latest
    ? `Workflow "${run.title}" failed: ${latest}`
    : `Workflow "${run.title}" failed.`;
}

/** Stamp the immutable reporting episode in the same candidate object that the
 * run store persists. Parked metadata revisions and terminal retries retain the
 * prior append-only sequence. */
export function stampWorkflowRunReportEpisode(
  previous: WorkflowRun | null,
  next: WorkflowRun,
  createdAt: string,
): WorkflowRun {
  if (next.schemaVersion !== WORKFLOW_RUN_SCHEMA_VERSION) return next;
  const entersPark = next.status === 'parked' && previous?.status !== 'parked';
  const entersTerminal = TERMINAL_STATUSES.has(next.status)
    && (!previous || !TERMINAL_STATUSES.has(previous.status));
  if (!entersPark && !entersTerminal) return next;

  const kind: WorkflowRunReportEpisode['kind'] = entersPark ? 'parked' : 'terminal';
  const outcome = entersPark ? 'parked' : next.status;
  if (outcome === 'running' || outcome === 'dispatched') return next;
  const reportEpisodes = previous?.reportEpisodes ?? next.reportEpisodes ?? [];
  const sequence = Math.max(previous?.reportSequence ?? 0, next.reportSequence ?? 0) + 1;
  const episode: WorkflowRunReportEpisode = {
    sequence,
    token: `${next.runId}:${kind}:${sequence}`,
    kind,
    outcome,
    createdAt,
    summary: episodeSummary(next, kind),
  };
  return {
    ...next,
    reportSequence: sequence,
    reportEpisodes: [...reportEpisodes, episode],
  };
}

function blockStatus(run: WorkflowRun): 'running' | 'waiting' | 'completed' | 'error' {
  if (run.status === 'parked') return 'waiting';
  if (run.status === 'completed') return 'completed';
  if (run.status === 'failed' || run.status === 'cancelled') return 'error';
  return 'running';
}

function activitySummary(run: WorkflowRun): string {
  if (run.status === 'parked') return 'Waiting for approval';
  if (run.status === 'completed') return 'Completed';
  if (run.status === 'failed') return 'Failed';
  if (run.status === 'cancelled') return 'Cancelled';
  return 'Running';
}

function latestOutcomePreview(run: WorkflowRun): string | undefined {
  for (let index = run.steps.length - 1; index >= 0; index--) {
    const summary = run.steps[index].outcome?.summary?.trim();
    if (summary) return summary.slice(0, 4_000);
  }
  return undefined;
}

const WORKFLOW_RUN_BLOCK_ID_MAX = 96;

function workflowRunBlockId(workflowId: string, runId: string): string {
  const full = `workflow-run:${workflowId}:${runId}`;
  if (full.length <= WORKFLOW_RUN_BLOCK_ID_MAX) return full;
  const digest = createHash('sha256')
    .update(`${workflowId}\u0000${runId}`)
    .digest('hex')
    .slice(0, 16);
  const readableWorkflow = workflowId.slice(0, 24);
  const readableRun = runId.slice(0, 24);
  return `workflow-run:${readableWorkflow}:${readableRun}:${digest}`;
}

export function workflowRunActivityEnvelope(
  run: WorkflowRun,
  action = run.revision === 1 ? 'started' : 'updated',
): ChatBlockEnvelope {
  const completedSteps = completedStepCount(run);
  const latestError = run.errors?.at(-1)?.message?.trim();
  const preview = latestOutcomePreview(run);
  return {
    op: 'put',
    block: {
      id: workflowRunBlockId(run.workflowId, run.runId),
      type: 'workflow-run',
      version: Math.max(1, run.revision ?? 1),
      status: blockStatus(run),
      title: run.title,
      summary: activitySummary(run),
      payload: {
        workflowId: run.workflowId,
        runId: run.runId,
        action,
        runStatus: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        completedSteps,
        totalSteps: run.steps.length,
        ...(run.parked?.description ? { parkedDescription: run.parked.description } : {}),
        ...(latestError ? { latestError: latestError.slice(0, 4_000) } : {}),
        ...(preview ? { preview } : {}),
        openPath: `/workflow/${encodeURIComponent(run.workflowId)}?mode=runs&run=${encodeURIComponent(run.runId)}`,
      },
    },
  };
}

function workflowRunReportPayload(
  run: WorkflowRun,
  episode: WorkflowRunReportEpisode,
  block: ChatBlockEnvelope,
): SessionDeliveryPayload {
  const completed = completedStepCount(run);
  let message: string;
  if (episode.kind === 'parked') {
    const detail = run.parked?.description?.trim() || episode.summary.trim();
    message = `Workflow "${run.title}" is waiting for approval.${detail ? `\n${detail}` : ''}`;
  } else if (episode.outcome === 'completed') {
    const preview = latestOutcomePreview(run);
    message = `Workflow "${run.title}" completed.\nCompleted ${completed} of ${run.steps.length} phases.${preview ? `\n\nLatest result:\n${preview}` : ''}`;
  } else if (episode.outcome === 'cancelled') {
    message = `Workflow "${run.title}" was cancelled.${episode.summary.trim() ? `\n${episode.summary.trim()}` : ''}`;
  } else {
    const detail = run.errors?.at(-1)?.message?.trim() || episode.summary.trim();
    message = `Workflow "${run.title}" failed.${detail ? `\n${detail}` : ''}`;
  }
  return {
    message,
    displayMessage: message,
    meta: {
      kind: 'workflow-run-report',
      workflowId: run.workflowId,
      runId: run.runId,
      episodeSequence: episode.sequence,
      outcome: episode.outcome,
    },
    block,
  };
}

/** Project the complete latest run block and claim every stable persisted report
 * episode through the one Session delivery lifecycle. The run file is the
 * authority: projection/claim failures are logged and retried by startup repair. */
export function projectWorkflowRunActivity(
  run: WorkflowRun,
  context: WorkflowReportingContext,
  actingSessionId?: string,
): ChatBlockEnvelope {
  const envelope = workflowRunActivityEnvelope(run);
  const fallback = blockFallbackText(envelope.block);
  const targets = [run.invocation?.sessionId, actingSessionId]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index);
  for (const sessionId of targets) {
    if (!context.sessionExists(sessionId)) continue;
    try {
      context.applyBlock(sessionId, envelope, fallback);
      context.emitBlock?.(sessionId, envelope, fallback);
    } catch (error) {
      context.log?.('warn', `[workflow-reporting] activity projection failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!run.invocation || run.invocation.reportMode === 'silent') return envelope;
  for (const episode of run.reportEpisodes ?? []) {
    const input = {
      targetSessionId: run.invocation.sessionId,
      sourceKind: 'workflow-run' as const,
      sourceId: `${run.workflowId}:${run.runId}`,
      sourceAttempt: episode.token,
      sourceOutcome: episode.outcome,
      sourceVersion: episode.sequence,
      deliveryKind: episode.kind === 'parked' ? 'workflow-parked' : 'workflow-terminal',
      payload: workflowRunReportPayload(run, episode, envelope),
    };
    try {
      const { delivery } = context.claimDelivery(input);
      if (delivery.status !== 'accepted') {
        void context.deliverClaimed(delivery.id).catch((error) => {
          context.log?.('warn', `[workflow-reporting] delivery ${delivery.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch (error) {
      context.log?.('warn', `[workflow-reporting] report claim failed for ${run.runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return envelope;
}

/** Rebuild transcript activity and claim missing persisted report episodes. This
 * intentionally performs no delivery: the one Session delivery startup recovery
 * pass owns leases, retries, dead-lettering, and engine wakeup immediately after. */
export function recoverWorkflowRunReporting(
  root: string,
  context: WorkflowReportingContext,
): { runs: number; claims: number } {
  let runs = 0;
  let claims = 0;
  const recoveryContext: WorkflowReportingContext = {
    ...context,
    claimDelivery: (input) => {
      const result = context.claimDelivery(input);
      if (result.claimed) claims++;
      return result;
    },
    deliverClaimed: async () => undefined,
  };
  for (const workflowId of listRunWorkflowIds(root)) {
    for (const summary of listRuns(root, workflowId)) {
      try {
        const run = getRun(root, workflowId, summary.runId);
        if (!run || run.schemaVersion !== WORKFLOW_RUN_SCHEMA_VERSION || !run.invocation) continue;
        runs++;
        projectWorkflowRunActivity(run, recoveryContext);
      } catch (error) {
        context.log?.('warn', `[workflow-reporting] recovery skipped ${workflowId}/${summary.runId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { runs, claims };
}
