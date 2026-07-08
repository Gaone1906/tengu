import { appendWorkItemEvent, createWorkItem, getWorkItem, getWorkItemBySourceRef, linkSession, STICKY_STATUSES, type WorkItem } from './store.js';
import { transitionDerived } from './transitions.js';
import { reconcileWorkItem } from './reconcile.js';
import { requestApproval, recordMirroredApprovalDecision } from './approvals.js';
import { logger } from '../shared/logger.js';
import { resolveApprovalRouteTarget, resolveRootApprovalTarget } from '../gateway/approval-authority.js';

/**
 * Workflow-run → Todo bridge (GRS-021a design §2 — the one missing structural
 * auto-mint point). A workflow RUN is company work, so it lands in the ledger:
 * `startWorkflowRun` mints one run-level Todo (idempotent on
 * `workflow:<workflowId>:<runId>` via the partial UNIQUE — re-entry/crash-safe
 * exactly like the cron bridge), the driver links every step session it SPAWNS
 * (fresh + shared-creation; posted follow-ups into pre-existing sessions are
 * deliberately NOT linked — the workflow does not own those sessions), and the
 * run's TERMINAL status is reflected onto the item (`completed → done`,
 * `failed → blocked`).
 *
 * Why the run — not step settles — closes workflow items: step sessions settle
 * `idle` between steps, so session-derived `in_review` (and a trust auto-close)
 * would close the item mid-run. The reconciler therefore derives only
 * `executing` for `source:'workflow'` items (reconcile.ts), and this bridge is
 * their terminal authority.
 *
 * Everything here is BEST-EFFORT by contract (the cron bridge's stance): a
 * ledger failure must never break the actual run. The driver receives this
 * object via the injected-deps seam (`RunDriverDeps.workItems`) with STRUCTURAL
 * param types, so `work-items/` never imports the workflow engine and unit
 * tests stub it freely.
 */

/** The minimal run shape the bridge needs — structural, no workflow imports. */
export interface BridgeRunRef {
  runId: string;
  workflowId: string;
  title: string;
  status?: string;
  trigger?: unknown;
  triggerTodoId?: string;
}

export const workflowRunSourceRef = (run: Pick<BridgeRunRef, 'workflowId' | 'runId'>): string =>
  `workflow:${run.workflowId}:${run.runId}`;

/** The minimal parked-gate shape the mirror needs — structural (no workflow
 *  imports). `ref` is the gate's own ref; `description` is the operator-facing
 *  ask (and the gate KEY fallback when there is no ref, matching resolve-gate's
 *  `resolvedRunGates` keying). */
export interface BridgeParkedGate {
  ref?: string;
  description: string;
}

/** Build the mirror `approval_ref`: `workflow-gate:<defId>:<runId>:<gateRef>`.
 *  gateRef = the gate's ref, else its description (resolve-gate's own key). The
 *  `workflow-gate:` prefix is what the decision route uses to route back to
 *  resolve-gate instead of applying the native consequence rules (design §1.3). */
export function workflowGateApprovalRef(run: Pick<BridgeRunRef, 'workflowId' | 'runId'>, gate: BridgeParkedGate): string {
  return `workflow-gate:${run.workflowId}:${run.runId}:${gate.ref ?? gate.description}`;
}

export interface WorkflowTodoBridge {
  /** Mint (idempotently) the run-level Todo. Called right after the durable run
   *  record is first saved — mint-before-drive, so intent survives any crash. */
  mintRunItem(run: BridgeRunRef): void;
  /** Attach a todo-triggered run to the existing summoning Todo instead of minting
   *  a sibling workflow item. */
  linkTriggeredRunItem(run: BridgeRunRef, todoId: string): void;
  /** Link a step session the driver spawned to the run's Todo and re-derive. */
  linkRunSession(run: BridgeRunRef, sessionId: string): void;
  /** Reflect a run reaching a terminal status onto its Todo. Idempotent: a
   *  no-op when the item already carries the mapped status or is sticky. */
  onRunTerminal(run: BridgeRunRef): void;
  /** Mirror a parked approval gate onto the run's Todo (GRS-021b, design §1.3):
   *  set a PENDING approval carrying the mirror ref, so the run surfaces in the
   *  ONE operator queue. Idempotent per (park) via `requestApproval`; the run
   *  store stays the single authority — deciding this approval routes back to
   *  resolve-gate. Best-effort; self-heals a lost mint like `linkRunSession`. */
  mirrorParkedGate(run: BridgeRunRef, gate: BridgeParkedGate): void;
  /** Clear a mirrored (`workflow-gate:`) PENDING approval on the run's Todo to
   *  match a gate that was resolved by the RUN AUTHORITY — no matter which path
   *  resolved it (the Todo route, the workflow UI's own resolve-gate, or a
   *  terminal repair). GRS-021b QA finding 1: without this, a gate resolved
   *  directly leaves the mirror pending forever, ghosting in "Needs you". The
   *  ledger REACTS to the run authority — this never touches the run/resolve
   *  path. Idempotent: a no-op when there is no Todo, no mirror, or it is already
   *  decided. Best-effort. */
  clearParkMirror(run: BridgeRunRef, decision: 'approve' | 'reject', decidedBy?: string): void;
}

function triggerTodoIdForRun(run: BridgeRunRef): string | undefined {
  const trigger = run.trigger;
  const payload = trigger && typeof trigger === 'object' && !Array.isArray(trigger) && 'payload' in trigger
    ? (trigger as { payload?: unknown }).payload
    : undefined;
  const fromPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).todoId
    : undefined;
  if (typeof fromPayload === 'string' && fromPayload !== '') return fromPayload;
  return run.triggerTodoId;
}

function runItem(run: BridgeRunRef): WorkItem | undefined {
  const triggerTodoId = triggerTodoIdForRun(run);
  if (triggerTodoId) return getWorkItem(triggerTodoId);
  return getWorkItemBySourceRef('workflow', workflowRunSourceRef(run));
}

/** Get the run's Todo, or create it (the cron bridge's guard-repair stance — a
 *  lost/failed mint self-heals wherever the item is next needed). */
function getOrCreateRunItem(run: BridgeRunRef): WorkItem {
  const triggerTodoId = triggerTodoIdForRun(run);
  if (triggerTodoId) {
    const item = getWorkItem(triggerTodoId);
    if (!item) throw new Error(`triggering Todo ${triggerTodoId} not found`);
    return item;
  }
  return (
    runItem(run) ??
    createWorkflowRunItem(run)
  );
}

function createWorkflowRunItem(run: BridgeRunRef): WorkItem {
  const root = resolveRootApprovalTarget();
  return createWorkItem({
    title: run.title,
    body: `Workflow run ${run.runId} of "${run.workflowId}".`,
    status: 'backlog',
    source: 'workflow',
    sourceRef: workflowRunSourceRef(run),
    // Workflow-run Todos route approvals to the COO, but the COO is not the
    // owner doing the work. Keeping owner null avoids self-approval rejection.
    assignee: null,
    department: root?.department ?? null,
  });
}

export function createWorkflowTodoBridge(): WorkflowTodoBridge {
  return {
    mintRunItem(run) {
      try {
        if (triggerTodoIdForRun(run)) return;
        createWorkflowRunItem(run);
      } catch (err) {
        logger.warn(`Workflow run ${run.runId}: Todo mint skipped: ${err instanceof Error ? err.message : err}`);
      }
    },

    linkTriggeredRunItem(run, todoId) {
      try {
        const item = getWorkItem(todoId);
        if (!item) throw new Error(`triggering Todo ${todoId} not found`);
        appendWorkItemEvent({
          workItemId: todoId,
          kind: 'note',
          actor: 'workflow-run',
          detail: { workflowId: run.workflowId, runId: run.runId, attached: true },
        });
      } catch (err) {
        logger.warn(`Workflow run ${run.runId}: Todo trigger-link skipped: ${err instanceof Error ? err.message : err}`);
      }
    },

    linkRunSession(run, sessionId) {
      try {
        // Get-or-create tolerates a lost/failed mint (the cron bridge's
        // guard-repair stance): the link path self-heals the item.
        const item = getOrCreateRunItem(run);
        linkSession(item.id, sessionId);
        reconcileWorkItem(item.id);
      } catch (err) {
        logger.warn(`Workflow run ${run.runId}: Todo step-link skipped: ${err instanceof Error ? err.message : err}`);
      }
    },

    mirrorParkedGate(run, gate) {
      try {
        const item = getOrCreateRunItem(run);
        requestApproval(item.id, {
          request: gate.description,
          ref: workflowGateApprovalRef(run, gate),
          target: resolveApprovalRouteTarget(item).target,
          actor: 'workflow-run',
        });
      } catch (err) {
        logger.warn(`Workflow run ${run.runId}: Todo park mirror skipped: ${err instanceof Error ? err.message : err}`);
      }
    },

    clearParkMirror(run, decision, decidedBy = 'operator') {
      try {
        const item = runItem(run); // GET only — no Todo means nothing to clear
        if (!item) return;
        if (!item.approvalRef?.startsWith('workflow-gate:')) return; // not a mirror
        if (item.approvalState !== 'pending') return; // idempotent — already decided
        recordMirroredApprovalDecision(item.id, decision, decidedBy);
      } catch (err) {
        logger.warn(`Workflow run ${run.runId}: Todo park-mirror clear skipped: ${err instanceof Error ? err.message : err}`);
      }
    },

    onRunTerminal(run) {
      try {
        if (triggerTodoIdForRun(run)) return; // Todo-triggered runs are driven by per-step todoTransition, not terminal reflection.
        const item = runItem(run);
        if (!item) return; // mint failed earlier and nothing linked — nothing to reflect
        const target = run.status === 'completed' ? 'done' : run.status === 'failed' ? 'blocked' : undefined;
        if (!target) return; // parked/running — not terminal, not ours (021b mirrors parks)
        if (item.status === target || STICKY_STATUSES.has(item.status)) return; // idempotent / operator owns it
        transitionDerived(item.id, target, 'workflow-run', { runId: run.runId, runStatus: run.status });
      } catch (err) {
        logger.warn(`Workflow run ${run.runId}: Todo terminal reflect skipped: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
