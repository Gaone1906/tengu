import { getDefinition, listDefinitions } from './definition-store.js';
import { startWorkflowRunFromTrigger, type RunDriverDeps } from './run-reconciler.js';
import { findRunByTriggerFireRef, type WorkflowRun } from './run-store.js';
import type { EditableWorkflowDefinition } from './definition.js';
import type { WorkflowTrigger } from './derive.js';
import type {
  WorkflowTodoEventClaimOutcome,
  WorkflowTodoStatusEvent,
} from '../work-items/workflow-event-feed.js';

export type TodoStatusWorkflowEvent = WorkflowTodoStatusEvent;

export type TodoStatusTriggerOutcome =
  | { workflowId: string; outcome: 'started'; run: WorkflowRun; detail: string }
  | { workflowId: string; outcome: 'duplicate'; runId: string; detail: string }
  | { workflowId: string; outcome: 'suppressed'; detail: string }
  | { workflowId: string; outcome: 'failed'; run: WorkflowRun; detail: string };

export interface TodoStatusReplayOptions {
  limit?: number;
}

export interface TodoStatusReplayOutcome {
  eventId: string;
  outcomes: Array<Pick<TodoStatusTriggerOutcome, 'workflowId' | 'outcome'>>;
}

/** An active workflow definition whose trigger is a todo-status-change, resolved
 * once so a replay batch does not re-read every definition per event. */
interface TodoStatusDef {
  def: EditableWorkflowDefinition;
  trigger: WorkflowTrigger;
}

function triggerTarget(trigger: WorkflowTrigger): string | undefined {
  return trigger.toStatus ?? trigger.status;
}

function triggerMatches(trigger: WorkflowTrigger, event: TodoStatusWorkflowEvent): boolean {
  if (trigger.kind !== 'todo-status-change') return false;
  if (triggerTarget(trigger) !== event.toStatus) return false;
  if (trigger.fromStatus && trigger.fromStatus !== event.fromStatus) return false;
  const filter = trigger.filter;
  if (!filter) return true;
  if (filter.source && filter.source !== event.item.source) return false;
  if (filter.department && filter.department !== event.item.department) return false;
  if (filter.assignee && filter.assignee !== event.item.assignee) return false;
  return true;
}

function loadActiveTodoStatusDefs(deps: RunDriverDeps): TodoStatusDef[] {
  const out: TodoStatusDef[] = [];
  for (const summary of listDefinitions(deps.root)) {
    let def;
    try {
      def = getDefinition(deps.root, summary.id);
    } catch {
      continue;
    }
    if (!def || def.status !== 'active') continue;
    const trigger = def.nodes.find((node) => node.type === 'trigger')?.trigger;
    if (!trigger || trigger.kind !== 'todo-status-change') continue;
    out.push({ def, trigger });
  }
  return out;
}

function requireEventFeed(deps: RunDriverDeps) {
  if (!deps.todoEventFeed) {
    throw new Error('todo-status Workflow dispatch requires a typed Todo event feed');
  }
  return deps.todoEventFeed;
}

function replayProcessedClaim(
  deps: RunDriverDeps,
  event: TodoStatusWorkflowEvent,
  outcomes: WorkflowTodoEventClaimOutcome[],
): TodoStatusTriggerOutcome[] {
  return outcomes.flatMap((outcome): TodoStatusTriggerOutcome[] => {
    if (outcome.outcome === 'suppressed') {
      return [{ workflowId: outcome.workflowId, outcome: 'suppressed', detail: outcome.detail }];
    }
    const run = findRunByTriggerFireRef(
      deps.root,
      outcome.workflowId,
      'todo-status-change',
      'todo.status_changed',
      event.id,
    );
    return run ? [{
      workflowId: outcome.workflowId,
      outcome: 'duplicate',
      runId: run.runId,
      detail: `todo event ${event.id} already ran as ${run.runId}`,
    }] : [];
  });
}

export async function fireTodoStatusChangeWorkflows(
  deps: RunDriverDeps,
  event: TodoStatusWorkflowEvent,
  preloadedDefs?: TodoStatusDef[],
): Promise<TodoStatusTriggerOutcome[]> {
  const feed = requireEventFeed(deps);
  const outcomes: TodoStatusTriggerOutcome[] = [];
  const defs = preloadedDefs ?? loadActiveTodoStatusDefs(deps);
  const matchingDefs = defs.filter(({ trigger }) => triggerMatches(trigger, event));
  const claim = feed.claimEvent(event.id, matchingDefs.map(({ def }) => def.id));
  if (claim.state === 'busy') return [];
  if (claim.state === 'processed') return replayProcessedClaim(deps, event, claim.outcomes);
  try {
    const claimedIds = new Set(claim.definitionIds);
    for (const { def } of matchingDefs.filter(({ def }) => claimedIds.has(def.id))) {
      const existing = findRunByTriggerFireRef(deps.root, def.id, 'todo-status-change', 'todo.status_changed', event.id);
      if (existing) {
        outcomes.push({
          workflowId: def.id,
          outcome: 'duplicate',
          runId: existing.runId,
          detail: `todo event ${event.id} already ran as ${existing.runId}`,
        });
        continue;
      }
      const run = await startWorkflowRunFromTrigger(deps, def, {
        source: 'todo-status-change',
        event: 'todo.status_changed',
        payload: {
          todoId: event.workItemId,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          source: event.item.source,
          department: event.item.department,
          assignee: event.item.assignee,
        },
        fireRef: event.id,
      }, { maxNodes: 100 });
      outcomes.push({
        workflowId: def.id,
        outcome: run.status === 'failed' ? 'failed' : 'started',
        run,
        detail: `workflow run ${run.runId} started from Todo ${event.workItemId} (status: ${run.status})`,
      });
    }
    feed.completeEvent(event.id, outcomes.map((outcome) => ({
      workflowId: outcome.workflowId,
      outcome: outcome.outcome,
      ...('run' in outcome ? { runId: outcome.run.runId } : {}),
      ...('runId' in outcome ? { runId: outcome.runId } : {}),
      detail: outcome.detail,
    })));
    return outcomes;
  } catch (err) {
    try {
      feed.releaseEvent(event.id);
    } catch {
      // Preserve the dispatch failure; a stale lease still permits crash recovery.
    }
    throw err;
  }
}

export async function replayMissedTodoStatusChangeWorkflowFires(
  deps: RunDriverDeps,
  opts: TodoStatusReplayOptions = {},
): Promise<TodoStatusReplayOutcome[]> {
  const rows = requireEventFeed(deps).listPendingEvents(opts.limit);
  const defs = loadActiveTodoStatusDefs(deps);
  const replayed: TodoStatusReplayOutcome[] = [];
  for (const event of rows) {
    const outcomes = await fireTodoStatusChangeWorkflows(deps, event, defs);
    if (outcomes.length === 0) continue;
    replayed.push({
      eventId: event.id,
      outcomes: outcomes.map((outcome) => ({ workflowId: outcome.workflowId, outcome: outcome.outcome })),
    });
  }
  return replayed;
}
