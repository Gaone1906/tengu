import { randomUUID } from 'node:crypto';
import { initDb } from '../sessions/registry.js';

/**
 * Work-item store — the substrate of the Todos ledger (GRS-002, elevated by
 * GRS-021a design §1).
 *
 * A work item ("Todo" in surface language) is the durable unit of intended
 * work; a session is one execution attempt against it (linked via the nullable
 * `sessions.work_item_id` FK). This module and the guarded
 * `work-items/transitions.ts` are the ONLY write paths.
 *
 * GRS-021a additions: the 8-status vocabulary + 7-value provenance enum
 * (`migrate.ts` owns the DDL + rebuild), acceptance criteria, verify policy
 * (TRUST/VERIFY/THOROUGH + verifier + maxRounds), rounds, budget (spend is
 * NEVER stored — always derived live from linked sessions' total_cost), the
 * approval fields (ORTHOGONAL to lifecycle position; a fresh item's approval is
 * always none — the §1.3 anti-bottleneck principle: creates cannot attach one),
 * and the append-only `work_item_events` audit.
 *
 * Trust the DB, not just TS callers: status/priority/source/approval_state are
 * enforced by CHECK constraints and machine-minted idempotency by a partial
 * UNIQUE index (DDL in `migrate.ts`).
 */

export type WorkItemStatus =
  | 'backlog'
  | 'assigned'
  | 'executing'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'escalated'
  | 'cancelled';
export type WorkItemSource = 'human' | 'delegation' | 'cron' | 'workflow' | 'session' | 'connector' | 'goal';
export type ApprovalState = 'pending' | 'approved' | 'rejected';
export type ApprovalTargetKind = 'employee' | 'virtual' | 'none';
export type VerifyMode = 'trust' | 'verify' | 'thorough';

/** Statuses that close an item — writes stamp/clear `closed_at` on these. */
const CLOSED_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['done', 'cancelled']);
/** Sticky terminals (design §1.1): the reconciler never derives an item OUT of
 *  these — `done`/`cancelled` are decisions, `escalated` is a deliberate routing
 *  to the operator that session churn must not silently undo. */
export const STICKY_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['done', 'cancelled', 'escalated']);

export interface VerifyPolicy {
  mode: VerifyMode;
  verifier?: { employee?: string; engine?: string; model?: string };
  maxRounds?: number;
}

/** Provenance defaults when `verify_policy` is NULL (design §1.5, operator-ruled):
 *  machine pulses auto-close (cron per fire; workflow runs carry their own gates),
 *  everything a mind delegates or captures is reviewed. */
export const DEFAULT_VERIFY_MODE_BY_SOURCE: Readonly<Record<WorkItemSource, VerifyMode>> = {
  cron: 'trust',
  workflow: 'trust',
  delegation: 'verify',
  human: 'verify',
  session: 'verify',
  connector: 'verify',
  goal: 'verify',
};

/** Bounce ceilings when the policy does not set `maxRounds` (design §1.5). */
export const DEFAULT_MAX_ROUNDS: Readonly<Record<VerifyMode, number>> = {
  trust: 2,
  verify: 2,
  thorough: 3,
};

/** Resolve the effective verify mode for an item (explicit policy, else the
 *  provenance default). Exported for the reconciler's TRUST hook and, later,
 *  the phase-2 dispatcher. */
export function effectiveVerifyMode(item: Pick<WorkItem, 'verifyPolicy' | 'source'>): VerifyMode {
  return item.verifyPolicy?.mode ?? DEFAULT_VERIFY_MODE_BY_SOURCE[item.source];
}

/** Resolve the effective bounce ceiling for an item. */
export function effectiveMaxRounds(item: Pick<WorkItem, 'verifyPolicy' | 'source'>): number {
  return item.verifyPolicy?.maxRounds ?? DEFAULT_MAX_ROUNDS[effectiveVerifyMode(item)];
}

export interface WorkItem {
  id: string;
  title: string;
  body: string | null;
  status: WorkItemStatus;
  department: string | null;
  assignee: string | null;
  priority: number;
  /** Nullable manual order key. Lower ranked values render first. */
  rank: number | null;
  source: WorkItemSource;
  sourceRef: string | null;
  acceptance: string | null;
  /** Parsed `verify_policy` JSON; null = provenance default applies. A corrupt
   *  stored value fails closed to VERIFY rather than falling back to a source
   *  default such as cron/workflow TRUST. */
  verifyPolicy: VerifyPolicy | null;
  rounds: number;
  budgetUsd: number | null;
  approvalState: ApprovalState | null;
  approvalRequest: string | null;
  approvalRef: string | null;
  approvalTarget: string | null;
  approvalTargetKind: ApprovalTargetKind | null;
  approvalEscalatedAt: string | null;
  approvalDecidedBy: string | null;
  approvalDecidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CreateWorkItemInput {
  title: string;
  body?: string | null;
  status?: WorkItemStatus;
  department?: string | null;
  assignee?: string | null;
  priority?: number;
  source?: WorkItemSource;
  /**
   * Stable key for machine-minted items (e.g. `cron:<jobId>:<fireIso>`,
   * `workflow:<defId>:<runId>`). When set, `createWorkItem` is idempotent on
   * `(source, sourceRef)` — a repeat insert returns the existing row instead of
   * creating a duplicate. NULL refs never collide.
   */
  sourceRef?: string | null;
  acceptance?: string | null;
  verifyPolicy?: VerifyPolicy | null;
  budgetUsd?: number | null;
  // Deliberately NO approval fields (design §1.3, anti-bottleneck principle):
  // a fresh Todo's approval is always none; approval is attached only by the
  // 021b decision/mirror machinery where a human decision is genuinely required.
}

export interface ListWorkItemsFilter {
  status?: WorkItemStatus;
  department?: string;
  assignee?: string;
  source?: WorkItemSource;
  needsAttentionFor?: string;
  /** Escaped-LIKE substring over title + body (%/_/backslash are literal). */
  text?: string;
  /** Inclusive ISO timestamp bounds over `updated_at`. */
  since?: string;
  until?: string;
  /** Cap rows in SQL (LIMIT) instead of the caller slicing after a full-table load. */
  limit?: number;
  /** Zero-based row offset, applied after the canonical ordering. */
  offset?: number;
}

export interface SearchWorkItemsFilter extends ListWorkItemsFilter {}

export type WorkItemTotals = Record<WorkItemStatus, number>;

export interface WorkItemPage {
  workItems: WorkItem[];
  /** Exact count matching the filters, before LIMIT/OFFSET. */
  total: number;
  /** Exact matching counts by raw stored status, before LIMIT/OFFSET. */
  totals: WorkItemTotals;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

function parseVerifyPolicy(raw: unknown): VerifyPolicy | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as VerifyPolicy;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { mode: 'verify' };
    return parsed.mode === 'trust' || parsed.mode === 'verify' || parsed.mode === 'thorough' ? parsed : { mode: 'verify' };
  } catch {
    return { mode: 'verify' };
  }
}

function rowToWorkItem(row: Record<string, unknown>): WorkItem {
  return {
    id: row.id as string,
    title: row.title as string,
    body: (row.body as string) ?? null,
    status: row.status as WorkItemStatus,
    department: (row.department as string) ?? null,
    assignee: (row.assignee as string) ?? null,
    priority: row.priority as number,
    rank: (row.rank as number) ?? null,
    source: row.source as WorkItemSource,
    sourceRef: (row.source_ref as string) ?? null,
    acceptance: (row.acceptance as string) ?? null,
    verifyPolicy: parseVerifyPolicy(row.verify_policy),
    rounds: (row.rounds as number) ?? 0,
    budgetUsd: (row.budget_usd as number) ?? null,
    approvalState: (row.approval_state as ApprovalState) ?? null,
    approvalRequest: (row.approval_request as string) ?? null,
    approvalRef: (row.approval_ref as string) ?? null,
    approvalTarget: (row.approval_target as string) ?? null,
    approvalTargetKind: (row.approval_target_kind as ApprovalTargetKind) ?? null,
    approvalEscalatedAt: (row.approval_escalated_at as string) ?? null,
    approvalDecidedBy: (row.approval_decided_by as string) ?? null,
    approvalDecidedAt: (row.approval_decided_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: (row.closed_at as string) ?? null,
  };
}

/** `wi_<12 hex>` — short, sortable-enough, collision-safe for this scale. */
function generateWorkItemId(): string {
  return `wi_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** True only for a UNIQUE-constraint violation — NOT a CHECK violation (those must
 *  still surface as errors, e.g. an invalid status). better-sqlite3 sets `.code`. */
function isUniqueConstraintError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/* ── Events (append-only audit, design §1.2) ────────────────────────────────── */

export type WorkItemEventKind =
  | 'created'
  | 'status_change'
  | 'note'
  | 'session_linked'
  | 'approval_requested'
  | 'approval_decided'
  | 'verify_result'
  | 'escalated';

export interface WorkItemEvent {
  id: string;
  workItemId: string;
  kind: WorkItemEventKind;
  fromStatus: WorkItemStatus | null;
  toStatus: WorkItemStatus | null;
  actor: string | null;
  /** Parsed JSON payload (critique text, session id, policy note, …). */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AppendWorkItemEventInput {
  workItemId: string;
  kind: WorkItemEventKind;
  fromStatus?: WorkItemStatus | null;
  toStatus?: WorkItemStatus | null;
  actor?: string | null;
  detail?: Record<string, unknown> | null;
}

/** Append one audit event. Callers inside a transaction compose naturally
 *  (better-sqlite3 nests via savepoints). Never throws on payload shape — the
 *  detail is stringified verbatim. */
export function appendWorkItemEvent(input: AppendWorkItemEventInput): WorkItemEvent {
  const db = initDb();
  const now = new Date().toISOString();
  const event: WorkItemEvent = {
    id: `wie_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    workItemId: input.workItemId,
    kind: input.kind,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    actor: input.actor ?? null,
    detail: input.detail ?? null,
    createdAt: now,
  };
  db.prepare(
    `INSERT INTO work_item_events (id, work_item_id, kind, from_status, to_status, actor, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.workItemId,
    event.kind,
    event.fromStatus,
    event.toStatus,
    event.actor,
    event.detail ? JSON.stringify(event.detail) : null,
    event.createdAt,
  );
  return event;
}

/** List an item's audit trail, oldest-first (the story reads top-down). */
export function listWorkItemEvents(workItemId: string): WorkItemEvent[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT * FROM work_item_events WHERE work_item_id = ? ORDER BY created_at, rowid')
    .all(workItemId) as Record<string, unknown>[];
  return rows.map((row) => {
    let detail: Record<string, unknown> | null = null;
    if (typeof row.detail === 'string' && row.detail) {
      try {
        detail = JSON.parse(row.detail) as Record<string, unknown>;
      } catch {
        detail = null;
      }
    }
    return {
      id: row.id as string,
      workItemId: row.work_item_id as string,
      kind: row.kind as WorkItemEventKind,
      fromStatus: (row.from_status as WorkItemStatus) ?? null,
      toStatus: (row.to_status as WorkItemStatus) ?? null,
      actor: (row.actor as string) ?? null,
      detail,
      createdAt: row.created_at as string,
    };
  });
}

/* ── Create / read ──────────────────────────────────────────────────────────── */

/**
 * Create a work item (status defaults to `backlog`, source to `human`).
 * Idempotent for machine-minted items: when `sourceRef` is set and a row already
 * exists for that `(source, sourceRef)` pair, the existing row is returned
 * unchanged — a repeat for the same key never duplicates AND never re-appends a
 * `created` event. The check+insert(+event) runs in one transaction; if a
 * concurrent writer wins the `(source, source_ref)` race between our SELECT and
 * INSERT, the UNIQUE violation is caught and we re-select the winner's row.
 * Invalid enum values are rejected by the table's CHECK constraints.
 */
export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const db = initDb();
  const now = new Date().toISOString();
  const id = generateWorkItemId();
  const status: WorkItemStatus = input.status ?? 'backlog';
  const source: WorkItemSource = input.source ?? 'human';
  const sourceRef = input.sourceRef ?? null;
  const priority = input.priority ?? 2;
  const closedAt = CLOSED_STATUSES.has(status) ? now : null;
  const verifyPolicyJson = input.verifyPolicy ? JSON.stringify(input.verifyPolicy) : null;

  const selectExisting = (): WorkItem | undefined => {
    const row = db
      .prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?')
      .get(source, sourceRef) as Record<string, unknown> | undefined;
    return row ? rowToWorkItem(row) : undefined;
  };

  const txn = db.transaction((): WorkItem => {
    if (sourceRef !== null) {
      const existing = selectExisting();
      if (existing) return existing;
    }
    try {
      db.prepare(
        `INSERT INTO work_items
           (id, title, body, status, department, assignee, priority, source, source_ref,
            acceptance, verify_policy, budget_usd, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.title,
        input.body ?? null,
        status,
        input.department ?? null,
        input.assignee ?? null,
        priority,
        source,
        sourceRef,
        input.acceptance ?? null,
        verifyPolicyJson,
        input.budgetUsd ?? null,
        now,
        now,
        closedAt,
      );
    } catch (err) {
      // Lost the idempotency race — another writer inserted the same key. Return
      // theirs rather than surfacing a constraint error. CHECK violations (bad
      // status/priority/source) are NOT unique errors, so they still throw.
      if (sourceRef !== null && isUniqueConstraintError(err)) {
        const existing = selectExisting();
        if (existing) return existing;
      }
      throw err;
    }
    appendWorkItemEvent({ workItemId: id, kind: 'created', toStatus: status, actor: source, detail: sourceRef ? { sourceRef } : null });
    return getWorkItem(id)!;
  });
  return txn();
}

export function getWorkItem(id: string): WorkItem | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToWorkItem(row) : undefined;
}

/** Look up a machine-minted item by its stable key — how the workflow bridge
 *  resolves a run's Todo without threading ids through the driver. */
export function getWorkItemBySourceRef(source: WorkItemSource, sourceRef: string): WorkItem | undefined {
  const db = initDb();
  const row = db
    .prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?')
    .get(source, sourceRef) as Record<string, unknown> | undefined;
  return row ? rowToWorkItem(row) : undefined;
}

const WORK_ITEM_STATUS_VALUES: readonly WorkItemStatus[] = [
  'backlog',
  'assigned',
  'executing',
  'in_review',
  'done',
  'blocked',
  'escalated',
  'cancelled',
];

function workItemWhere(filter: ListWorkItemsFilter): { sql: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.text) {
    const like = `%${filter.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conditions.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    values.push(like, like);
  }
  if (filter.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.department) {
    conditions.push('department = ?');
    values.push(filter.department);
  }
  if (filter.assignee) {
    conditions.push('assignee = ?');
    values.push(filter.assignee);
  }
  if (filter.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter.needsAttentionFor) {
    conditions.push("((approval_state = 'pending' AND approval_target = ?) OR (assignee = ? AND status IN ('blocked', 'escalated')))");
    values.push(filter.needsAttentionFor, filter.needsAttentionFor);
  }
  if (filter.since) {
    conditions.push('updated_at >= ?');
    values.push(filter.since);
  }
  if (filter.until) {
    conditions.push('updated_at <= ?');
    values.push(filter.until);
  }
  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

/** Paginated, deterministic AND-composed Todo query. Counts are computed from
 * the identical WHERE clause before pagination, so a capped page can never
 * masquerade as the full ledger. */
export function queryWorkItems(filter: ListWorkItemsFilter = {}): WorkItemPage {
  const db = initDb();
  const { sql: where, values } = workItemWhere(filter);
  const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit)
    ? Math.max(0, Math.floor(filter.limit))
    : 20;
  const offset = typeof filter.offset === 'number' && Number.isFinite(filter.offset)
    ? Math.max(0, Math.floor(filter.offset))
    : 0;
  const rows = db
    .prepare(`SELECT * FROM work_items ${where} ORDER BY (rank IS NULL) ASC, rank ASC, updated_at DESC, created_at DESC, id ASC LIMIT ? OFFSET ?`)
    .all(...values, limit, offset) as Record<string, unknown>[];
  const counts = db
    .prepare(`SELECT status, COUNT(*) AS total FROM work_items ${where} GROUP BY status`)
    .all(...values) as Array<{ status: WorkItemStatus; total: number }>;
  const totals = Object.fromEntries(WORK_ITEM_STATUS_VALUES.map((status) => [status, 0])) as WorkItemTotals;
  for (const count of counts) totals[count.status] = count.total;
  const total = counts.reduce((sum, count) => sum + count.total, 0);
  const workItems = rows.map(rowToWorkItem);
  const consumed = offset + workItems.length;
  return {
    workItems,
    total,
    totals,
    limit,
    offset,
    nextOffset: workItems.length > 0 && consumed < total ? consumed : null,
  };
}

/** List work items, recently-updated first, optionally filtered. Compatibility
 * wrapper: an omitted limit still means the full matching set. */
export function listWorkItems(filter?: ListWorkItemsFilter): WorkItem[] {
  return queryWorkItems({ ...(filter ?? {}), limit: filter?.limit ?? 2_147_483_647 }).workItems;
}

/** Deterministic AND-composed Todo search (GRS-021c). */
export function searchWorkItems(filter: SearchWorkItemsFilter, limit = 20): WorkItem[] {
  if (!filter.text && !filter.status && !filter.source && !filter.assignee && !filter.department && !filter.needsAttentionFor && !filter.since && !filter.until) {
    throw new Error('searchWorkItems requires at least one filter');
  }
  return queryWorkItems({ ...filter, limit }).workItems;
}

export interface UpdateWorkItemInput {
  title?: string;
  body?: string | null;
  assignee?: string | null;
  department?: string | null;
  priority?: number;
  rank?: number | null;
}

/** Metadata-only Todo write used by the operator edit/reorder surface. Status is
 * deliberately absent from the input type: lifecycle changes belong to the
 * guarded transitions module. */
export function updateWorkItem(id: string, input: UpdateWorkItemInput, actor?: string | null): WorkItem | undefined {
  const db = initDb();
  const fields: Array<{ column: string; name: keyof UpdateWorkItemInput; value: unknown }> = [];
  if (input.title !== undefined) fields.push({ column: 'title', name: 'title', value: input.title });
  if (input.body !== undefined) fields.push({ column: 'body', name: 'body', value: input.body });
  if (input.assignee !== undefined) fields.push({ column: 'assignee', name: 'assignee', value: input.assignee });
  if (input.department !== undefined) fields.push({ column: 'department', name: 'department', value: input.department });
  if (input.priority !== undefined) fields.push({ column: 'priority', name: 'priority', value: input.priority });
  if (input.rank !== undefined) fields.push({ column: 'rank', name: 'rank', value: input.rank });
  if (fields.length === 0) return getWorkItem(id);

  const txn = db.transaction((): WorkItem | undefined => {
    const now = new Date().toISOString();
    const result = db
      .prepare(`UPDATE work_items SET ${fields.map((field) => `${field.column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((field) => field.value), now, id);
    if (result.changes === 0) return undefined;
    appendWorkItemEvent({
      workItemId: id,
      kind: 'note',
      actor: actor ?? null,
      detail: { updatedFields: fields.map((field) => field.name) },
    });
    return getWorkItem(id);
  });
  return txn();
}

/** Live spend over an item's execution attempts: `SUM(total_cost)` across linked
 *  sessions. Never stored (design §1.6) — always derived, never stale. */
export function getWorkItemSpend(id: string): number {
  const db = initDb();
  const row = db
    .prepare('SELECT COALESCE(SUM(total_cost), 0) AS spend FROM sessions WHERE work_item_id = ?')
    .get(id) as { spend: number };
  return row.spend;
}

/* ── Link + raw status write ────────────────────────────────────────────────── */

/**
 * Link an execution attempt (session) to a work item. Touches two rows
 * (`sessions.work_item_id` + `work_items.updated_at`) so it runs in one
 * transaction: if the work item does not exist, the session write is rolled back
 * and nothing is half-linked. Throws when either the session or the work item is
 * missing. Appends a `session_linked` audit event on an ACTUAL write.
 *
 * Idempotent-in-writes: if the session already carries this exact `work_item_id`,
 * the call verifies both rows exist and then returns WITHOUT writing — so a
 * redundant re-link (e.g. the GRS-003b-2b guard-time bridge repair on a re-fire)
 * does not churn `work_items.updated_at` or the event log.
 */
export function linkSession(workItemId: string, sessionId: string): void {
  const db = initDb();
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    const session = db
      .prepare('SELECT work_item_id FROM sessions WHERE id = ?')
      .get(sessionId) as { work_item_id: string | null } | undefined;
    if (!session) throw new Error(`linkSession: session ${sessionId} not found`);
    const workItemExists = db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(workItemId);
    if (!workItemExists) throw new Error(`linkSession: work item ${workItemId} not found`);
    // Already linked to this exact item → no write, no `updated_at` bump.
    if (session.work_item_id === workItemId) return;
    db.prepare('UPDATE sessions SET work_item_id = ? WHERE id = ?').run(workItemId, sessionId);
    db.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, workItemId);
    appendWorkItemEvent({ workItemId, kind: 'session_linked', detail: { sessionId } });
  });
  txn();
}

export interface UpdateStatusOptions {
  /**
   * When true, the write is guarded with `AND status NOT IN (<sticky set>)`, so it
   * matches 0 rows (returns undefined) if the item was closed/escalated
   * concurrently. Used by the reconciler to make sticky-terminal invariance
   * DB-enforced rather than read-time only. Default false preserves the
   * unconditional behavior for the transitions module (which validates edges
   * itself and IS allowed to leave `escalated` under human authority).
   */
  ifNotSticky?: boolean;
}

/**
 * INTERNAL raw status write — reconciler + transitions module only (design §1.2:
 * routes and tools go through `transition()`, which validates edges and writes
 * the audit event). Stamps `closed_at` when entering `done`/`cancelled` and
 * clears it when leaving them. Invalid `toStatus` is rejected by the CHECK
 * constraint. Returns the updated item, or undefined if the id is unknown (or,
 * with `ifNotSticky`, if the item is sticky-terminal).
 */
function updateStatus(
  id: string,
  toStatus: WorkItemStatus,
  actor?: string,
  opts?: UpdateStatusOptions,
): WorkItem | undefined {
  void actor; // audit lives in transitions.ts events; kept for call-site readability
  const db = initDb();
  const now = new Date().toISOString();
  const closedClause = CLOSED_STATUSES.has(toStatus) ? `, closed_at = COALESCE(closed_at, ?)` : `, closed_at = NULL`;
  const guardClause = opts?.ifNotSticky ? ` AND status NOT IN ('done', 'cancelled', 'escalated')` : '';
  const params: unknown[] = [toStatus, now];
  if (CLOSED_STATUSES.has(toStatus)) params.push(now);
  params.push(id);
  const result = db
    .prepare(`UPDATE work_items SET status = ?, updated_at = ?${closedClause} WHERE id = ?${guardClause}`)
    .run(...params);
  if (result.changes === 0) return undefined;
  return getWorkItem(id);
}
