import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import type { WorkItemSource, WorkItemStatus } from './store.js';
import { getWorkItemLabels } from './labels.js';
import { isTodoId } from './id.js';

export interface WorkflowTodoStatusEvent {
  id: string;
  workItemId: string;
  fromStatus: WorkItemStatus | null;
  toStatus: WorkItemStatus;
  /** Who performed the transition, read from the audit row's own `actor`
   *  column rather than the provenance snapshot — so every event written
   *  before the trigger filter existed replays with its actor intact. */
  actor: string | null;
  item: {
    source: WorkItemSource;
    department: string | null;
    assignee: string | null;
    /** Read live at replay time, not from the frozen provenance snapshot: labels
     *  are re-tagged independently of status, so a trigger filter must see the
     *  Todo's current set rather than whatever it carried when it moved. */
    labels: Array<{ id: string; name: string }>;
  };
}

export interface WorkflowTodoEventClaimOutcome {
  workflowId: string;
  outcome: 'started' | 'duplicate' | 'suppressed' | 'failed';
  runId?: string;
  detail: string;
}

export type WorkflowTodoEventClaim =
  | { state: 'acquired'; definitionIds: string[] }
  | { state: 'busy' }
  | { state: 'processed'; outcomes: WorkflowTodoEventClaimOutcome[] };

export interface WorkflowTodoEventFeed {
  claimEvent(eventId: string, definitionIds: string[]): WorkflowTodoEventClaim;
  completeEvent(eventId: string, outcomes: WorkflowTodoEventClaimOutcome[]): void;
  releaseEvent(eventId: string): void;
  listPendingEvents(limit?: number): WorkflowTodoStatusEvent[];
}

export interface WorkflowTodoEventFeedOptions {
  ownerId?: string;
  now?: () => Date;
  leaseMs?: number;
}

interface TodoEventClaimRow {
  state: 'processing' | 'processed';
  owner: string;
  definition_ids: string;
  outcomes: string | null;
  claimed_at: string;
}

interface TodoEventRow {
  id: string;
  work_item_id: string;
  from_status: WorkItemStatus;
  to_status: WorkItemStatus;
  actor: string | null;
  detail: string | null;
}

const CLAIMS_TABLE = 'workflow_todo_event_claims';
const CLAIMS_MIGRATION_KEY = 'todo_status_event_claims_migrated';
const LEGACY_WATERMARK_KEY = 'todo_status_replay_watermark';
const CLAIM_OWNER = randomUUID();
const DEFAULT_CLAIM_LEASE_MS = 30_000;
let claimsTableReady = false;

function ensureClaimsTable(): ReturnType<typeof initDb> {
  const db = initDb();
  if (claimsTableReady) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS ${CLAIMS_TABLE} (
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
            db.prepare(
              `INSERT OR IGNORE INTO ${CLAIMS_TABLE}
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

function parseOutcomes(raw: string | null): WorkflowTodoEventClaimOutcome[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as WorkflowTodoEventClaimOutcome[] : [];
  } catch {
    return [];
  }
}

function replayLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 500;
  return Math.max(1, Math.min(5000, Math.floor(limit as number)));
}

const WORK_ITEM_SOURCES = new Set<WorkItemSource>([
  'human', 'delegation', 'cron', 'workflow', 'session', 'connector', 'goal',
]);

function eventFromImmutableSnapshot(row: TodoEventRow): WorkflowTodoStatusEvent | null {
  if (!isTodoId(row.work_item_id)) return null;
  if (!row.detail) return null;
  try {
    const detail = JSON.parse(row.detail) as { todoProvenance?: unknown };
    const snapshot = detail.todoProvenance;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const value = snapshot as Record<string, unknown>;
    if (typeof value.source !== 'string' || !WORK_ITEM_SOURCES.has(value.source as WorkItemSource)) return null;
    if (value.department !== null && typeof value.department !== 'string') return null;
    if (value.assignee !== null && typeof value.assignee !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(value, 'department') || !Object.prototype.hasOwnProperty.call(value, 'assignee')) return null;
    return {
      id: row.id,
      workItemId: row.work_item_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actor: row.actor,
      item: {
        source: value.source as WorkItemSource,
        department: value.department as string | null,
        assignee: value.assignee as string | null,
        labels: getWorkItemLabels(row.work_item_id).map(({ id, name }) => ({ id, name })),
      },
    };
  } catch {
    return null;
  }
}

export function createWorkflowTodoEventFeed(opts: WorkflowTodoEventFeedOptions = {}): WorkflowTodoEventFeed {
  const owner = opts.ownerId ?? CLAIM_OWNER;
  const now = opts.now ?? (() => new Date());
  const leaseMs = Math.max(1, opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS);
  return {
    claimEvent(eventId, definitionIds) {
      const db = ensureClaimsTable();
      return db.transaction((): WorkflowTodoEventClaim => {
        const existing = db.prepare(
          `SELECT state, owner, definition_ids, outcomes, claimed_at FROM ${CLAIMS_TABLE} WHERE event_id = ?`,
        ).get(eventId) as TodoEventClaimRow | undefined;
        if (!existing) {
          db.prepare(
            `INSERT INTO ${CLAIMS_TABLE}
              (event_id, state, owner, definition_ids, outcomes, claimed_at, processed_at)
             VALUES (?, 'processing', ?, ?, NULL, ?, NULL)`,
          ).run(eventId, owner, JSON.stringify(definitionIds), now().toISOString());
          return { state: 'acquired', definitionIds };
        }
        if (existing.state === 'processed') {
          return { state: 'processed', outcomes: parseOutcomes(existing.outcomes) };
        }
        if (existing.owner === owner) return { state: 'busy' };
        const claimedAt = Date.parse(existing.claimed_at);
        if (Number.isFinite(claimedAt) && now().getTime() - claimedAt <= leaseMs) return { state: 'busy' };
        const takeover = db.prepare(
          `UPDATE ${CLAIMS_TABLE} SET owner = ?, claimed_at = ?
           WHERE event_id = ? AND state = 'processing' AND owner = ? AND claimed_at = ?`,
        ).run(owner, now().toISOString(), eventId, existing.owner, existing.claimed_at);
        if (takeover.changes !== 1) return { state: 'busy' };
        return { state: 'acquired', definitionIds: parseStringArray(existing.definition_ids) };
      }).immediate();
    },

    completeEvent(eventId, outcomes) {
      ensureClaimsTable().prepare(
        `UPDATE ${CLAIMS_TABLE}
         SET state = 'processed', outcomes = ?, processed_at = ?
         WHERE event_id = ? AND state = 'processing' AND owner = ?`,
      ).run(JSON.stringify(outcomes), now().toISOString(), eventId, owner);
    },

    releaseEvent(eventId) {
      ensureClaimsTable().prepare(
        `UPDATE ${CLAIMS_TABLE}
         SET owner = ?, claimed_at = ?
         WHERE event_id = ? AND state = 'processing' AND owner = ?`,
      ).run(`released:${randomUUID()}`, new Date(0).toISOString(), eventId, owner);
    },

    listPendingEvents(limit) {
      const db = ensureClaimsTable();
      const rows = db.prepare(
        `SELECT e.id, e.work_item_id, e.from_status, e.to_status, e.actor, e.detail
         FROM work_item_events e
         LEFT JOIN ${CLAIMS_TABLE} c ON c.event_id = e.id
         WHERE e.from_status IS NOT NULL
           AND e.to_status IS NOT NULL
           AND e.kind IN ('status_change', 'escalated')
           AND (c.state IS NULL OR c.state = 'processing')
         ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
      ).all(replayLimit(limit)).reverse() as TodoEventRow[];
      return db.transaction(() => rows.flatMap((row): WorkflowTodoStatusEvent[] => {
        const event = eventFromImmutableSnapshot(row);
        if (event) return [event];
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO ${CLAIMS_TABLE}
            (event_id, state, owner, definition_ids, outcomes, claimed_at, processed_at)
           VALUES (?, 'processed', 'legacy-incomplete-provenance', '[]', '[]', ?, ?)`,
        ).run(row.id, now, now);
        return [];
      }))();
    },
  };
}
