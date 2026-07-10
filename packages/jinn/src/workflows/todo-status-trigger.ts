import { randomUUID } from 'node:crypto';
import { getDefinition, listDefinitions } from './definition-store.js';
import { startWorkflowRunFromTrigger, type RunDriverDeps } from './run-reconciler.js';
import { findRunByTriggerFireRef, getRun, listActiveRunRefs, workflowRunTriggerTodoId, type WorkflowRun } from './run-store.js';
import type { EditableWorkflowDefinition } from './definition.js';
import { initDb } from '../sessions/registry.js';
import type { WorkflowTrigger } from './derive.js';
import type { WorkItemSource, WorkItemStatus } from '../work-items/store.js';

export interface TodoStatusWorkflowEvent {
  id: string;
  workItemId: string;
  fromStatus: WorkItemStatus | null;
  toStatus: WorkItemStatus;
  item: {
    source: WorkItemSource;
    department: string | null;
    assignee: string | null;
  };
}

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

const NON_TERMINAL_RUN_STATUSES = new Set(['running', 'parked', 'dispatched']);

const TODO_EVENT_CLAIMS_TABLE = 'workflow_todo_event_claims';
const CLAIMS_MIGRATION_KEY = 'todo_status_event_claims_migrated';
const LEGACY_WATERMARK_KEY = 'todo_status_replay_watermark';
const CLAIM_OWNER = randomUUID();
let claimsTableReady = false;

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

function hasNonTerminalRunForTodo(deps: RunDriverDeps, workflowId: string, todoId: string): boolean {
  // Only active (non-terminal) runs can match — read the active-run index instead
  // of parsing every lifetime run file for this workflow. The status re-check
  // guards against a stale index entry.
  for (const ref of listActiveRunRefs(deps.root)) {
    if (ref.workflowId !== workflowId) continue;
    const run = getRun(deps.root, workflowId, ref.runId);
    if (!run || !NON_TERMINAL_RUN_STATUSES.has(run.status)) continue;
    if (workflowRunTriggerTodoId(run) === todoId) return true;
  }
  return false;
}

/** Resolve every active workflow whose trigger is a todo-status-change, once — so
 * a replay batch reads definitions a single time, not once per event. */
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
    const trigger = def.nodes.find((n) => n.type === 'trigger')?.trigger;
    if (!trigger || trigger.kind !== 'todo-status-change') continue;
    out.push({ def, trigger });
  }
  return out;
}

interface StoredClaimOutcome {
  workflowId: string;
  outcome: TodoStatusTriggerOutcome['outcome'];
  runId?: string;
  detail: string;
}

interface TodoEventClaimRow {
  state: 'processing' | 'processed';
  owner: string;
  definition_ids: string;
  outcomes: string | null;
}

type TodoEventClaim =
  | { state: 'acquired'; definitionIds: string[] }
  | { state: 'busy' }
  | { state: 'processed'; outcomes: StoredClaimOutcome[] };

function ensureTodoEventClaimsTable(): ReturnType<typeof initDb> {
  const db = initDb();
  if (claimsTableReady) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS ${TODO_EVENT_CLAIMS_TABLE} (
    event_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('processing', 'processed')),
    owner TEXT NOT NULL,
    definition_ids TEXT NOT NULL,
    outcomes TEXT,
    claimed_at TEXT NOT NULL,
    processed_at TEXT
  )`);
  const migrated = db.prepare('SELECT value FROM meta WHERE key = ?').get(CLAIMS_MIGRATION_KEY) as { value: string } | undefined;
  if (!migrated) {
    db.transaction(() => {
      const legacy = db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_WATERMARK_KEY) as { value: string } | undefined;
      if (legacy) {
        try {
          const cursor = JSON.parse(legacy.value) as { createdAt?: unknown; rowid?: unknown };
          if (typeof cursor.createdAt === 'string' && Number.isFinite(cursor.rowid)) {
            // Upgrade bridge only: the old cursor is accepted as evidence that all
            // rows at/before it were considered. New processing never advances or
            // consults a global watermark.
            db.prepare(
              `INSERT OR IGNORE INTO ${TODO_EVENT_CLAIMS_TABLE}
                (event_id, state, owner, definition_ids, outcomes, claimed_at, processed_at)
               SELECT id, 'processed', 'legacy-watermark', '[]', '[]', created_at, ?
               FROM work_item_events
               WHERE created_at < ? OR (created_at = ? AND rowid <= ?)`,
            ).run(new Date().toISOString(), cursor.createdAt, cursor.createdAt, Number(cursor.rowid));
          }
        } catch {
          // A corrupt legacy cursor carries no trustworthy migration evidence.
        }
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(CLAIMS_MIGRATION_KEY, '1');
    })();
  }
  claimsTableReady = true;
  return db;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseStoredOutcomes(raw: string | null): StoredClaimOutcome[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as StoredClaimOutcome[] : [];
  } catch {
    return [];
  }
}

/**
 * Claim one event atomically. A different owner means a previous gateway process
 * crashed mid-dispatch, so boot replay may resume its frozen definition set. The
 * same owner means live dispatch is still in progress and replay must not race it.
 */
function claimTodoEvent(eventId: string, definitionIds: string[]): TodoEventClaim {
  const db = ensureTodoEventClaimsTable();
  return db.transaction((): TodoEventClaim => {
    const existing = db.prepare(
      `SELECT state, owner, definition_ids, outcomes
       FROM ${TODO_EVENT_CLAIMS_TABLE}
       WHERE event_id = ?`,
    ).get(eventId) as TodoEventClaimRow | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO ${TODO_EVENT_CLAIMS_TABLE}
          (event_id, state, owner, definition_ids, outcomes, claimed_at, processed_at)
         VALUES (?, 'processing', ?, ?, NULL, ?, NULL)`,
      ).run(eventId, CLAIM_OWNER, JSON.stringify(definitionIds), new Date().toISOString());
      return { state: 'acquired', definitionIds };
    }
    if (existing.state === 'processed') {
      return { state: 'processed', outcomes: parseStoredOutcomes(existing.outcomes) };
    }
    if (existing.owner === CLAIM_OWNER) return { state: 'busy' };
    db.prepare(
      `UPDATE ${TODO_EVENT_CLAIMS_TABLE}
       SET owner = ?, claimed_at = ?
       WHERE event_id = ? AND state = 'processing'`,
    ).run(CLAIM_OWNER, new Date().toISOString(), eventId);
    return { state: 'acquired', definitionIds: parseStringArray(existing.definition_ids) };
  })();
}

function completeTodoEventClaim(eventId: string, outcomes: TodoStatusTriggerOutcome[]): void {
  const stored: StoredClaimOutcome[] = outcomes.map((outcome) => ({
    workflowId: outcome.workflowId,
    outcome: outcome.outcome,
    ...('run' in outcome ? { runId: outcome.run.runId } : {}),
    ...('runId' in outcome ? { runId: outcome.runId } : {}),
    detail: outcome.detail,
  }));
  ensureTodoEventClaimsTable().prepare(
    `UPDATE ${TODO_EVENT_CLAIMS_TABLE}
     SET state = 'processed', outcomes = ?, processed_at = ?
     WHERE event_id = ? AND state = 'processing' AND owner = ?`,
  ).run(JSON.stringify(stored), new Date().toISOString(), eventId, CLAIM_OWNER);
}

function replayProcessedClaim(
  deps: RunDriverDeps,
  event: TodoStatusWorkflowEvent,
  outcomes: StoredClaimOutcome[],
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
  const outcomes: TodoStatusTriggerOutcome[] = [];
  const defs = preloadedDefs ?? loadActiveTodoStatusDefs(deps);
  const matchingDefs = defs.filter(({ trigger }) => triggerMatches(trigger, event));
  const claim = claimTodoEvent(event.id, matchingDefs.map(({ def }) => def.id));
  if (claim.state === 'busy') return [];
  if (claim.state === 'processed') return replayProcessedClaim(deps, event, claim.outcomes);
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
    if (hasNonTerminalRunForTodo(deps, def.id, event.workItemId)) {
      outcomes.push({
        workflowId: def.id,
        outcome: 'suppressed',
        detail: `workflow "${def.id}" already has a non-terminal run linked to Todo ${event.workItemId}`,
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
    }, {
      maxNodes: 100,
    });
    outcomes.push({
      workflowId: def.id,
      outcome: run.status === 'failed' ? 'failed' : 'started',
      run,
      detail: `workflow run ${run.runId} started from Todo ${event.workItemId} (status: ${run.status})`,
    });
  }
  completeTodoEventClaim(event.id, outcomes);
  return outcomes;
}

function replayLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 500;
  return Math.max(1, Math.min(5000, Math.floor(limit as number)));
}

interface TodoEventRow {
  id: string;
  work_item_id: string;
  from_status: WorkItemStatus;
  to_status: WorkItemStatus;
  source: WorkItemSource;
  department: string | null;
  assignee: string | null;
  rowid: number;
  created_at: string;
}

export async function replayMissedTodoStatusChangeWorkflowFires(
  deps: RunDriverDeps,
  opts: TodoStatusReplayOptions = {},
): Promise<TodoStatusReplayOutcome[]> {
  const db = initDb();
  const limit = replayLimit(opts.limit);
  ensureTodoEventClaimsTable();

  // Per-event claims make completion order irrelevant: replay only rows with no
  // claim, plus abandoned `processing` claims from a prior gateway process.
  const baseSelect = `SELECT
         e.id,
         e.work_item_id,
         e.from_status,
         e.to_status,
         w.source,
         w.department,
         w.assignee,
         e.rowid AS rowid,
         e.created_at AS created_at
       FROM work_item_events e
       JOIN work_items w ON w.id = e.work_item_id
       LEFT JOIN ${TODO_EVENT_CLAIMS_TABLE} c
         ON c.event_id = e.id
       WHERE e.from_status IS NOT NULL
         AND e.to_status IS NOT NULL
         AND e.kind IN ('status_change', 'escalated')
         AND (c.state IS NULL OR c.state = 'processing')`;

  const rows = db
    .prepare(`${baseSelect} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`)
    .all(limit)
    .reverse() as TodoEventRow[];

  // Read every active todo-status definition ONCE for the whole batch rather than
  // re-reading all definitions per event.
  const defs = loadActiveTodoStatusDefs(deps);

  const replayed: TodoStatusReplayOutcome[] = [];
  for (const row of rows) {
    const outcomes = await fireTodoStatusChangeWorkflows(deps, {
      id: row.id,
      workItemId: row.work_item_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      item: {
        source: row.source,
        department: row.department,
        assignee: row.assignee,
      },
    }, defs);
    if (outcomes.length === 0) continue;
    replayed.push({
      eventId: row.id,
      outcomes: outcomes.map((outcome) => ({ workflowId: outcome.workflowId, outcome: outcome.outcome })),
    });
  }
  return replayed;
}
