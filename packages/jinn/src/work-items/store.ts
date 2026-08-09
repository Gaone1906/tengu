import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { initDb } from '../shared/db.js';
import { loadConfig } from '../shared/config.js';
import { CONFIG_PATH } from '../shared/paths.js';
import { parseTodoId, resolveTodoIdPrefix } from './id.js';
import { resolveDepartmentPrefix } from './departments.js';
import { allocateWorkItemId, useWorkItemAllocationClaim } from './migrate.js';
import { currentApproval, currentApprovalsByItem, type WorkItemApproval } from './approval-rows.js';
import { currentVerifyCommand, currentVerifyCommandsByItem, upsertVerifyCommand } from './verify-rows.js';
import { currentFanout, currentFanoutsByItem, upsertFanout, type WorkItemFanout } from './fanout-rows.js';
import { currentWorkspace, currentWorkspacesByItem, upsertWorkspacePath, type WorkItemWorkspace } from './workspace-rows.js';
import { currentProfile, currentProfilesByItem, upsertProfileId, type WorkItemProfile } from './profile-rows.js';
import { resolvePhase } from './phases.js';

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
 * Trust the DB, not just TS callers: status/priority/source are enforced by
 * CHECK constraints and machine-minted idempotency by a partial UNIQUE index
 * (DDL in `migrate.ts`).
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

/** Actor recorded on the reconciler's own derived writes. */
export const RECONCILER_ACTOR = 'reconciler';
/** Actor recorded when a Workflow run reflects its own lifecycle onto its bound
 *  Todo. Derived, not declared: a status a phase set on purpose outranks it. */
export const WORKFLOW_RUN_ACTOR = 'workflow:run';

/** Actors whose status writes are DERIVED — reflections of machine state rather
 *  than a caller's decision about the work. */
const DERIVED_ACTORS: ReadonlySet<string> = new Set([RECONCILER_ACTOR, WORKFLOW_RUN_ACTOR]);

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
  /** Council/specialist redesign (docs/tengu/18-council-specialists.md, D21):
   *  a label on the tree, exactly parallel to `department` — per-project
   *  vocabulary (`work_item_phases`, rootId-scoped), not a new tree depth. */
  phase: string | null;
  assignee: string | null;
  /** Who asked for this item: 'operator', an employee slug, or 'system'. */
  createdBy: string;
  /** Sub-task tree (Todos v2): parent link, denormalized root, and depth 0..3. */
  parentId: string | null;
  rootId: string;
  depth: number;
  dueAt: string | null;
  priority: number;
  /** Nullable manual order key. Lower ranked values render first. */
  rank: number | null;
  /** Monotonic row revision used for whole-Todo optimistic concurrency. */
  version: number;
  source: WorkItemSource;
  sourceRef: string | null;
  acceptance: string | null;
  /** Parsed `verify_policy` JSON; null = provenance default applies. A corrupt
   *  stored value fails closed to VERIFY rather than falling back to a source
   *  default such as cron/workflow TRUST. */
  verifyPolicy: VerifyPolicy | null;
  rounds: number;
  budgetUsd: number | null;
  /** Checkpointing (docs/tengu/10-checkpointing.md): the machine-checkable
   *  done-criterion for a depth-3 sub-sub-task — a shell command that exits 0
   *  when the unit is verifiably complete. Null for any item that is not a
   *  depth-3 leaf, or a depth-3 leaf that has not been given one yet. Stored in
   *  `work_item_verify` (additive table), not a `work_items` column — overlaid
   *  onto every read the same way approval fields are. */
  verifyCommand: string | null;
  /** Fan-out planning gate (docs/tengu/07-fanout-policy.md, D8): the planner's
   *  call, justified in the body. Defaults false/null for every item that has
   *  never had one set — sequential is always the safe reading. Stored in
   *  `work_item_fanout` (additive table), not a `work_items` column — overlaid
   *  the same way verify/approval fields are. */
  parallelSafe: boolean;
  parallelGroup: string | null;
  /** Project identity (docs/tengu/03-implementation-plan.md step 11): root =
   *  project, matching the one-root-per-outcome convention. Set only on a
   *  depth-0 item; always null on any deeper Todo. Stored in
   *  `work_item_workspace` (additive table), overlaid the same way
   *  verify/fanout are. */
  workspacePath: string | null;
  /** Council/specialist redesign (D22): which user-defined profile a root
   *  Todo belongs to. Set only on a depth-0 item; always null on any deeper
   *  Todo. Stored in `work_item_profile` (additive table), overlaid the same
   *  way verify/fanout/workspace are. */
  profileId: string | null;
  approvalState: ApprovalState | null;
  approvalRequest: string | null;
  approvalRef: string | null;
  /** Offered variants when the current approval asks for a PICK (else null). */
  approvalOptions: string[] | null;
  approvalChoice: string | null;
  /** The current approval is reserved for the human operator: no employee may
   *  decide it, not the COO and not through escalation. */
  approvalOperatorOnly: boolean;
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
  /** D21: per-project vocabulary, inherited from the parent when not given
   *  explicitly — same rule as `department`. */
  phase?: string | null;
  assignee?: string | null;
  /** Creator identity; defaults to 'operator' for source=human, 'system' otherwise. */
  createdBy?: string;
  /** Create as a sub-task of an existing Todo (depth ≤ 3). Department is
   *  inherited from the parent when not given explicitly. */
  parentId?: string | null;
  /** Optional ISO 8601 deadline. */
  dueAt?: string | null;
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
  /** Depth-3 sub-sub-tasks only — a machine-checkable shell command; see
   *  `WorkItem.verifyCommand`. Throws at create time if the item being created
   *  will not land at depth 3. */
  verifyCommand?: string | null;
  /** Fan-out planning gate (docs/tengu/07-fanout-policy.md Gate 1). Defaults
   *  false when omitted — must be affirmatively set true by the planner. */
  parallelSafe?: boolean;
  parallelGroup?: string | null;
  /** Project identity (docs/tengu/03-implementation-plan.md step 11). Only
   *  valid on a root create (no `parentId`) — throws otherwise, same shape as
   *  `verifyCommand`'s depth-3 guard. */
  workspacePath?: string | null;
  /** D22: only valid on a root create (no `parentId`) — throws otherwise,
   *  same shape as `workspacePath`'s depth-0 guard. */
  profileId?: string | null;
  // Deliberately NO approval fields (design §1.3, anti-bottleneck principle):
  // a fresh Todo's approval is always none; approval is attached only by the
  // 021b decision/mirror machinery where a human decision is genuinely required.
}

export interface ListWorkItemsFilter {
  status?: WorkItemStatus;
  department?: string;
  /** D21: per-project vocabulary — exact match, same as `department`. */
  phase?: string;
  assignee?: string;
  source?: WorkItemSource;
  needsAttentionFor?: string;
  /** Exact creator identity (`created_by`). */
  createdBy?: string;
  /** Direct children of this Todo. */
  parentId?: string;
  /** Whole family sharing this root Todo. */
  rootId?: string;
  /** Only tree roots (parentless items). */
  rootsOnly?: boolean;
  /** Items carrying this label, matched by exact label id (`lbl_…`) or stored
   *  (normalized kebab-case) name — callers normalize display names first. */
  label?: string;
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

/** A work_items row as stored: everything on a WorkItem EXCEPT the approval
 *  facts, which live only in `work_item_approvals`. Producing a WorkItem
 *  therefore requires `overlayApproval` — a read path that skips hydration
 *  cannot silently serve all-null approvals, because it will not typecheck. */
type WorkItemRowBase = Omit<WorkItem,
  | 'approvalState' | 'approvalRequest' | 'approvalRef' | 'approvalOptions' | 'approvalChoice' | 'approvalOperatorOnly'
  | 'approvalTarget' | 'approvalTargetKind' | 'approvalEscalatedAt' | 'approvalDecidedBy' | 'approvalDecidedAt'
  | 'verifyCommand' | 'parallelSafe' | 'parallelGroup' | 'workspacePath' | 'profileId'>;

function rowToWorkItem(row: Record<string, unknown>): WorkItemRowBase {
  return {
    id: row.id as string,
    title: row.title as string,
    body: (row.body as string) ?? null,
    status: row.status as WorkItemStatus,
    department: (row.department as string) ?? null,
    phase: (row.phase as string) ?? null,
    assignee: (row.assignee as string) ?? null,
    createdBy: row.created_by as string,
    parentId: (row.parent_id as string) ?? null,
    rootId: row.root_id as string,
    depth: (row.depth as number) ?? 0,
    dueAt: (row.due_at as string) ?? null,
    priority: row.priority as number,
    rank: (row.rank as number) ?? null,
    version: row.version as number,
    source: row.source as WorkItemSource,
    sourceRef: (row.source_ref as string) ?? null,
    acceptance: (row.acceptance as string) ?? null,
    verifyPolicy: parseVerifyPolicy(row.verify_policy),
    rounds: (row.rounds as number) ?? 0,
    budgetUsd: (row.budget_usd as number) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: (row.closed_at as string) ?? null,
  };
}

/**
 * The ONLY producer of a WorkItem's approval + verify + fan-out fields: the
 * item's current `work_item_approvals` row (or "no approval" when it has
 * none), its current `work_item_verify` command (or null), and its current
 * `work_item_fanout` annotation (or the false/null default when the planner
 * never set one). Applied explicitly at every read function (single reads
 * hydrate per item; page/tree reads batch), which keeps EVERY consumer —
 * payloads, authority checks, activity cards, transitions' returns — sourcing
 * all three from one place.
 */
function overlayApproval(
  base: WorkItemRowBase,
  approval: WorkItemApproval | undefined,
  verifyCommand: string | undefined,
  fanout: WorkItemFanout | undefined,
  workspace: WorkItemWorkspace | undefined,
  profile: WorkItemProfile | undefined,
): WorkItem {
  return {
    ...base,
    verifyCommand: verifyCommand ?? null,
    parallelSafe: fanout?.parallelSafe ?? false,
    parallelGroup: fanout?.parallelGroup ?? null,
    workspacePath: workspace?.workspacePath ?? null,
    profileId: profile?.profileId ?? null,
    approvalState: approval?.state ?? null,
    approvalRequest: approval?.request ?? null,
    approvalRef: approval?.ref ?? null,
    approvalOptions: approval?.options ?? null,
    approvalChoice: approval?.choice ?? null,
    approvalOperatorOnly: approval?.operatorOnly ?? false,
    approvalTarget: approval?.target ?? null,
    approvalTargetKind: approval?.targetKind ?? null,
    approvalEscalatedAt: approval?.escalatedAt ?? null,
    approvalDecidedBy: approval?.decidedBy ?? null,
    approvalDecidedAt: approval?.decidedAt ?? null,
  };
}

function hydrateApprovals(items: WorkItemRowBase[]): WorkItem[] {
  if (items.length === 0) return [];
  const ids = items.map((item) => item.id);
  const currentByItem = currentApprovalsByItem(ids);
  const verifyByItem = currentVerifyCommandsByItem(ids);
  const fanoutByItem = currentFanoutsByItem(ids);
  const workspaceByItem = currentWorkspacesByItem(ids);
  const profileByItem = currentProfilesByItem(ids);
  return items.map((item) => overlayApproval(
    item,
    currentByItem.get(item.id),
    verifyByItem.get(item.id),
    fanoutByItem.get(item.id),
    workspaceByItem.get(item.id),
    profileByItem.get(item.id),
  ));
}

/** True only for a UNIQUE-constraint violation — NOT a CHECK violation (those must
 *  still surface as errors, e.g. an invalid status). better-sqlite3 sets `.code`. */
function isUniqueConstraintError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/* ── Events (append-only audit, design §1.2) ────────────────────────────────── */

export type WorkItemEventKind =
  | 'created'
  | 'child_created'
  | 'comment_added'
  | 'comment_edited'
  | 'comment_deleted'
  | 'relation_added'
  | 'relation_removed'
  | 'label_changed'
  | 'attachment_added'
  | 'attachment_removed'
  | 'metadata_edited'
  | 'status_change'
  | 'note'
  | 'session_linked'
  | 'approval_requested'
  | 'approval_decided'
  | 'verify_result'
  | 'escalated'
  | 'phase_changed';

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
  /** `state` advances the Todo revision for a standalone operator-visible note
   * or verification result. `companion` records the audit for a row mutation
   * that already advanced it. `audit` is telemetry/visibility only. */
  versionEffect?: 'state' | 'companion' | 'audit';
}

/** Append one audit event. Callers inside a transaction compose naturally
 *  (better-sqlite3 nests via savepoints). Never throws on payload shape — the
 *  detail is stringified verbatim. */
export function appendWorkItemEvent(input: AppendWorkItemEventInput): WorkItemEvent {
  const db = initDb();
  const workItemId = parseTodoId(input.workItemId);
  const now = new Date().toISOString();
  const event: WorkItemEvent = {
    id: `wie_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    workItemId,
    kind: input.kind,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    actor: input.actor ?? null,
    detail: input.detail ?? null,
    createdAt: now,
  };
  const versionEffect = input.versionEffect
    ?? (input.kind === 'note' || input.kind === 'verify_result' ? 'state' : 'companion');
  const txn = db.transaction((): WorkItemEvent => {
    if (versionEffect === 'state') {
      const touched = db.prepare('UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, input.workItemId);
      if (touched.changes === 0) throw new Error('cannot append state event for an unknown Todo');
    }
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
  });
  return txn();
}

interface StatusTransitionProvenance {
  fromStatus: WorkItemStatus | null;
  actor: string | null;
  detail: string | null;
}

/** Read the newest transition into a status without loading the full audit trail. */
function latestStatusTransition(workItemId: string, toStatus: WorkItemStatus): StatusTransitionProvenance | undefined {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const row = db
    .prepare(
      `SELECT from_status, actor, detail FROM work_item_events
       WHERE work_item_id = ? AND to_status = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(id, toStatus) as { from_status: WorkItemStatus | null; actor: string | null; detail: string | null } | undefined;
  return row
    ? {
        fromStatus: row.from_status,
        actor: row.actor,
        detail: row.detail,
      }
    : undefined;
}

/**
 * Whether the current block was declared by a caller rather than derived from
 * attempt transport. Historical events without an explicit marker fall back to
 * actor provenance so existing rows retain their intended meaning.
 */
export function isBlockDeclared(workItemId: string): boolean {
  const row = latestStatusTransition(workItemId, 'blocked');
  if (!row) return false;
  if (row.detail) {
    try {
      const detail = JSON.parse(row.detail) as Record<string, unknown>;
      if (detail.declared === true) return true;
      if (detail.declared === false) return false;
    } catch {
      // Historical malformed detail falls through to actor provenance.
    }
  }
  return row.actor !== null && !DERIVED_ACTORS.has(row.actor);
}

/**
 * Whether the current execution state was explicitly reopened from review.
 * Inspect the newest transition into `executing` first so an older bounce
 * cannot outlive a later start or unblock.
 */
export function isReviewBounceDeclared(workItemId: string): boolean {
  return latestStatusTransition(workItemId, 'executing')?.fromStatus === 'in_review';
}

function rowToWorkItemEvent(row: Record<string, unknown>): WorkItemEvent {
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
}

/** List audit trails for several items with one query, oldest-first within
 * each item. Unknown ids receive an empty entry. */
export function listWorkItemEventsForItems(workItemIds: readonly string[]): Map<string, WorkItemEvent[]> {
  const ids = [...new Set(workItemIds.map((id) => parseTodoId(id)))];
  const eventsById = new Map(ids.map((id) => [id, [] as WorkItemEvent[]]));
  if (ids.length === 0) return eventsById;
  const db = initDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM work_item_events WHERE work_item_id IN (${placeholders}) ORDER BY created_at, rowid`)
    .all(...ids) as Record<string, unknown>[];
  for (const row of rows) {
    const event = rowToWorkItemEvent(row);
    eventsById.get(event.workItemId)?.push(event);
  }
  return eventsById;
}

/** List an item's audit trail, oldest-first (the story reads top-down). */
export function listWorkItemEvents(workItemId: string): WorkItemEvent[] {
  const id = parseTodoId(workItemId);
  return listWorkItemEventsForItems([id]).get(id) ?? [];
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
  // The burn commits before the create. An idempotent hit or a lost race discards the
  // claim and leaves a permanent gap in the company Todo sequence, which is valid by design.
  // A configless disposable/test home retains the historical JIN default. Once a
  // real config exists, malformed configuration must still fail closed rather than
  // silently allocating from the wrong company namespace.
  let parent: WorkItem | undefined;
  if (input.parentId) {
    parent = getWorkItem(input.parentId);
    if (!parent) throw new Error(`parent Todo ${input.parentId} not found`);
    // Closed parents refuse new children (the roll-up gate would otherwise be
    // violable by construction order). `escalated` deliberately stays creatable-
    // under: escalation routes an item to the operator, and decomposing it into
    // sub-tasks is a legitimate part of resolving it.
    if (parent.status === 'done' || parent.status === 'cancelled') {
      throw new Error(`parent Todo ${parent.id} is ${parent.status} — sub-tasks cannot be added under a closed Todo`);
    }
    if (parent.depth >= 3) {
      throw new Error(`parent Todo ${parent.id} is at depth ${parent.depth} — the sub-task tree is capped at depth 3`);
    }
  }
  const depth = parent ? parent.depth + 1 : 0;
  // Checkpointing (docs/tengu/10-checkpointing.md): `verify` is a sub-sub-task
  // (depth 3) concept only — depth is 0-indexed here (root/task/sub-task/
  // sub-sub-task = 0/1/2/3), confirmed against the CHECK constraint in
  // migrate.ts rather than assumed.
  if (input.verifyCommand !== undefined && input.verifyCommand !== null && depth !== 3) {
    throw new Error(`verifyCommand can only be set on a depth-3 sub-sub-task (this item would be depth ${depth})`);
  }
  // Project identity (docs/tengu/03-implementation-plan.md step 11): root =
  // project, matching the one-root-per-outcome convention — only a depth-0
  // create may carry a workspacePath.
  if (input.workspacePath !== undefined && input.workspacePath !== null && depth !== 0) {
    throw new Error(`workspacePath can only be set on a root Todo (this item would be depth ${depth})`);
  }
  // Council/specialist redesign (D22): a profile is a namespace on a project,
  // matching the same root-only convention workspacePath uses.
  if (input.profileId !== undefined && input.profileId !== null && depth !== 0) {
    throw new Error(`profileId can only be set on a root Todo (this item would be depth ${depth})`);
  }
  const companyPrefix = resolveCompanyPrefix();
  const department = input.department !== undefined ? input.department : parent?.department ?? null;
  const phase = input.phase !== undefined ? input.phase : parent?.phase ?? null;
  const prefix = department ? resolveDepartmentPrefix(db, department, companyPrefix) : companyPrefix;
  const claim = allocateWorkItemId(db, now, prefix);
  const id = claim.id;
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
    // Overlay like every other WorkItem-producing read: a retried machine mint
    // can hit an item that has since gained an approval.
    return row ? overlayApproval(rowToWorkItem(row), currentApproval(row.id as string), currentVerifyCommand(row.id as string), currentFanout(row.id as string), currentWorkspace(row.id as string), currentProfile(row.id as string)) : undefined;
  };

  const txn = db.transaction((): WorkItem => {
    if (sourceRef !== null) {
      const existing = selectExisting();
      if (existing) return existing;
    }
    try {
      db.prepare(
        `INSERT INTO work_items
           (id, title, body, status, department, assignee, created_by, parent_id, root_id, depth, due_at,
            priority, source, source_ref, acceptance, verify_policy, budget_usd, created_at, updated_at, closed_at, phase)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.title,
        input.body ?? null,
        status,
        department,
        input.assignee ?? null,
        input.createdBy ?? (source === 'human' ? 'operator' : 'system'),
        parent?.id ?? null,                       // parent_id
        parent ? parent.rootId : id,              // root_id
        depth,
        input.dueAt ?? null,
        priority,
        source,
        sourceRef,
        input.acceptance ?? null,
        verifyPolicyJson,
        input.budgetUsd ?? null,
        now,
        now,
        closedAt,
        phase,
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
    if (input.verifyCommand) {
      upsertVerifyCommand(id, input.verifyCommand);
    }
    // A row is only worth writing when it says something other than the
    // false/null default overlayApproval already returns for an absent one.
    if (input.parallelSafe || input.parallelGroup != null) {
      upsertFanout(id, { parallelSafe: input.parallelSafe ?? false, parallelGroup: input.parallelGroup ?? null });
    }
    if (input.workspacePath) {
      upsertWorkspacePath(id, input.workspacePath);
    }
    if (input.profileId) {
      upsertProfileId(id, input.profileId);
    }
    if (phase) {
      resolvePhase(db, parent ? parent.rootId : id, phase);
    }
    if (parent) {
      // Re-verify the parent under the write lock before auditing the link.
      const liveParent = db.prepare('SELECT depth FROM work_items WHERE id = ?').get(parent.id) as { depth: number } | undefined;
      if (!liveParent) throw new Error(`parent Todo ${parent.id} disappeared during create`);
      appendWorkItemEvent({
        workItemId: parent.id,
        kind: 'child_created',
        actor: input.createdBy ?? source,
        detail: { childId: id },
        versionEffect: 'state',   // bump the parent so tree views resort
      });
    }
    return getWorkItem(id)!;
  });
  return useWorkItemAllocationClaim(db, claim, () => txn());
}

/** The company Todo namespace: derived from configured company name, or the
 *  explicit `portal.companyPrefix` override; configless homes keep `JIN`. */
export function resolveCompanyPrefix(): string {
  const portal = fs.existsSync(CONFIG_PATH) ? loadConfig().portal : undefined;
  return resolveTodoIdPrefix(portal?.companyName ?? 'Tengu', portal?.companyPrefix);
}

/** Register a department in the registry if it is not there yet (review F2):
 *  EVERY write that lands a non-null department calls this inside its own
 *  transaction, so /api/departments can never omit a department that holds
 *  live Todos. Items keep their birth ID prefix — this only mints the row. */
export function ensureDepartmentRegistered(slug: string | null | undefined): void {
  if (typeof slug !== 'string' || !slug) return;
  resolveDepartmentPrefix(initDb(), slug, resolveCompanyPrefix());
}

export function getWorkItem(id: string): WorkItem | undefined {
  const db = initDb();
  const todoId = parseTodoId(id);
  const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(todoId) as Record<string, unknown> | undefined;
  return row ? overlayApproval(rowToWorkItem(row), currentApproval(todoId), currentVerifyCommand(todoId), currentFanout(todoId), currentWorkspace(todoId), currentProfile(todoId)) : undefined;
}

/**
 * Set (insert or replace) a Todo's fan-out planning annotation, auditing the
 * change (docs/tengu/07-fanout-policy.md Gate 1). `parallelSafe: true`
 * without a justification in the caller's own todo-body edit is a planner
 * discipline issue, not something this function can enforce — it only
 * records the decision and the audit trail for it.
 */
export function setWorkItemFanout(workItemId: string, input: { parallelSafe: boolean; parallelGroup?: string | null }, actor: string): WorkItemFanout {
  const item = getWorkItem(workItemId);
  if (!item) throw new Error(`work item ${workItemId} not found`);
  const stored = upsertFanout(item.id, input);
  appendWorkItemEvent({
    workItemId: item.id,
    kind: 'metadata_edited',
    actor,
    detail: { parallelSafe: stored.parallelSafe, parallelGroup: stored.parallelGroup },
    versionEffect: 'companion',
  });
  return stored;
}

/**
 * Set (insert or replace) a root Todo's project workspace path, auditing the
 * change (docs/tengu/03-implementation-plan.md step 11). Throws for a
 * non-root item — a project is a root, and giving a deeper Todo its own
 * workspace identity would break the one-root-per-outcome convention the
 * stand-up groups by.
 */
export function setWorkItemWorkspace(workItemId: string, workspacePath: string, actor: string): WorkItemWorkspace {
  const item = getWorkItem(workItemId);
  if (!item) throw new Error(`work item ${workItemId} not found`);
  if (item.depth !== 0) throw new Error(`workspacePath can only be set on a root Todo (${item.id} is depth ${item.depth})`);
  const stored = upsertWorkspacePath(item.id, workspacePath);
  appendWorkItemEvent({
    workItemId: item.id,
    kind: 'metadata_edited',
    actor,
    detail: { workspacePath: stored.workspacePath },
    versionEffect: 'companion',
  });
  return stored;
}

/**
 * Set (or clear) a Todo's phase (docs/tengu/18-council-specialists.md, D21):
 * a label on the tree, exactly parallel to `department` — not a new depth.
 * Registers the phase in the project's `work_item_phases` registry (rootId-
 * scoped) if it is not there yet, writes the plain column, and audits the
 * transition with a dedicated `phase_changed` event rather than the generic
 * `metadata_edited` one, so phase history reads as its own timeline.
 */
export function setWorkItemPhase(workItemId: string, phase: string | null, actor: string): WorkItem {
  const db = initDb();
  const item = getWorkItem(workItemId);
  if (!item) throw new Error(`work item ${workItemId} not found`);
  if (phase === item.phase) return item;
  const txn = db.transaction((): WorkItem => {
    if (phase) resolvePhase(db, item.rootId, phase);
    const now = new Date().toISOString();
    db.prepare('UPDATE work_items SET phase = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(phase, now, item.id);
    appendWorkItemEvent({
      workItemId: item.id,
      kind: 'phase_changed',
      actor,
      detail: { fromPhase: item.phase, toPhase: phase },
      versionEffect: 'companion',
    });
    return getWorkItem(item.id)!;
  });
  return txn();
}

/** Read a bounded set of Todos in caller order with one row query and one
 * approval hydration pass. Unknown ids are omitted. */
export function getWorkItems(ids: readonly string[]): WorkItem[] {
  const requestedIds = [...new Set(ids.map((id) => parseTodoId(id)))];
  if (requestedIds.length === 0) return [];
  const db = initDb();
  const placeholders = requestedIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM work_items WHERE id IN (${placeholders})`)
    .all(...requestedIds) as Record<string, unknown>[];
  const byId = new Map(hydrateApprovals(rows.map(rowToWorkItem)).map((item) => [item.id, item]));
  return requestedIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

/** Look up a machine-minted item by its stable key — how the workflow bridge
 *  resolves a run's Todo without threading ids through the driver. */
export function getWorkItemBySourceRef(source: WorkItemSource, sourceRef: string): WorkItem | undefined {
  const db = initDb();
  const row = db
    .prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?')
    .get(source, sourceRef) as Record<string, unknown> | undefined;
  return row ? overlayApproval(rowToWorkItem(row), currentApproval(row.id as string), currentVerifyCommand(row.id as string), currentFanout(row.id as string), currentWorkspace(row.id as string), currentProfile(row.id as string)) : undefined;
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
    let exactTodoId: string | null = null;
    try {
      exactTodoId = parseTodoId(filter.text);
    } catch {
      // Non-ID text remains an ordinary title/body query.
    }
    if (exactTodoId) {
      conditions.push("(id = ? OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      values.push(exactTodoId, like, like);
    } else {
      conditions.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      values.push(like, like);
    }
  }
  if (filter.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.department) {
    conditions.push('department = ?');
    values.push(filter.department);
  }
  if (filter.phase) {
    conditions.push('phase = ?');
    values.push(filter.phase);
  }
  if (filter.assignee) {
    conditions.push('assignee = ?');
    values.push(filter.assignee);
  }
  if (filter.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter.createdBy) {
    conditions.push('created_by = ?');
    values.push(filter.createdBy);
  }
  if (filter.parentId) {
    conditions.push('parent_id = ?');
    values.push(parseTodoId(filter.parentId));
  }
  if (filter.rootId) {
    conditions.push('root_id = ?');
    values.push(parseTodoId(filter.rootId));
  }
  if (filter.rootsOnly) {
    conditions.push('parent_id IS NULL');
  }
  if (filter.label) {
    conditions.push(
      'EXISTS (SELECT 1 FROM work_item_labels wil JOIN labels l ON l.id = wil.label_id WHERE wil.work_item_id = work_items.id AND (l.id = ? OR l.name = ?))',
    );
    values.push(filter.label, filter.label);
  }
  if (filter.needsAttentionFor) {
    // Approvals live in work_item_approvals — their sole storage owner since
    // PLA-48 dropped the shadow columns from work_items.
    conditions.push(
      "(EXISTS (SELECT 1 FROM work_item_approvals wap WHERE wap.work_item_id = work_items.id AND wap.state = 'pending' AND wap.target = ?) OR (assignee = ? AND status IN ('blocked', 'escalated')))",
    );
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
  const workItems = hydrateApprovals(rows.map(rowToWorkItem));
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

/** Statuses that mean "ready to pick up" for the continuous loop (step 8,
 *  D19): created but not yet actively worked. `executing` already has a live
 *  session; `in_review`/`blocked`/`escalated` need a human or a reviewer;
 *  `done`/`cancelled` are terminal. */
const OPEN_ASSIGNABLE_STATUSES: readonly WorkItemStatus[] = ['backlog', 'assigned'];

/**
 * Continuous loop's assignment query (docs/tengu/03-implementation-plan.md
 * step 8, D19): the next open work item for `assignee`, highest priority
 * first, ties broken exactly the way the ledger already orders work
 * (`queryWorkItems`'s own ORDER BY). Zero-token, deterministic `SELECT` —
 * never a dispatcher employee, never a model call (D6).
 */
export function nextOpenWorkItemForAssignee(assignee: string): WorkItem | undefined {
  const db = initDb();
  const placeholders = OPEN_ASSIGNABLE_STATUSES.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT * FROM work_items WHERE assignee = ? AND status IN (${placeholders})
       ORDER BY priority DESC, (rank IS NULL) ASC, rank ASC, updated_at DESC, created_at DESC, id ASC
       LIMIT 1`,
    )
    .get(assignee, ...OPEN_ASSIGNABLE_STATUSES) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const [item] = hydrateApprovals([rowToWorkItem(row)]);
  return item;
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

export type WorkItemTreeNode = WorkItem & { children: WorkItemTreeNode[] };

export interface WorkItemTree {
  root: WorkItemTreeNode;
  /** Status counts over the returned subtree (root included). */
  totals: WorkItemTotals;
  /** Live derived spend over every session linked anywhere in the subtree. */
  spendUsd: number;
}

/** Read multiple work-item subtrees without query fan-out. One indexed query
 *  fetches every requested family via root_id, then one grouped session query
 *  fetches spend for those families; each requested subtree is assembled and
 *  totalled in memory. Unknown IDs are omitted from the returned record. */
export function getWorkItemTrees(ids: readonly string[]): Record<string, WorkItemTree> {
  const requestedIds = [...new Set(ids.map((id) => parseTodoId(id)))];
  if (requestedIds.length === 0) return {};
  const db = initDb();
  const placeholders = requestedIds.map(() => '?').join(', ');
  const requestedRoots = `SELECT root_id FROM work_items WHERE id IN (${placeholders})`;
  const family = hydrateApprovals(
    (db
      .prepare(`SELECT * FROM work_items WHERE root_id IN (${requestedRoots})`)
      .all(...requestedIds) as Record<string, unknown>[])
      .map(rowToWorkItem),
  );
  if (family.length === 0) return {};
  const itemsById = new Map(family.map((item) => [item.id, item]));
  const childrenByParent = new Map<string, WorkItem[]>();
  for (const member of family) {
    if (!member.parentId) continue;
    const siblings = childrenByParent.get(member.parentId) ?? [];
    siblings.push(member);
    childrenByParent.set(member.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id));
  }
  const build = (node: WorkItem): WorkItemTreeNode => ({
    ...node,
    children: (childrenByParent.get(node.id) ?? []).map(build),
  });

  const spendRows = db
    .prepare(
      `SELECT sessions.work_item_id AS work_item_id, COALESCE(SUM(sessions.total_cost), 0) AS spend
       FROM sessions
       JOIN work_items ON work_items.id = sessions.work_item_id
       WHERE work_items.root_id IN (${requestedRoots})
       GROUP BY sessions.work_item_id`,
    )
    .all(...requestedIds) as Array<{ work_item_id: string; spend: number }>;
  const spendByItem = new Map(spendRows.map((row) => [row.work_item_id, row.spend]));

  const trees: Record<string, WorkItemTree> = {};
  for (const id of requestedIds) {
    const item = itemsById.get(id);
    if (!item) continue;
    const root = build(item);
    const totals = Object.fromEntries(WORK_ITEM_STATUS_VALUES.map((status) => [status, 0])) as WorkItemTotals;
    let spendUsd = 0;
    const walk = (node: WorkItemTreeNode): void => {
      totals[node.status] += 1;
      spendUsd += spendByItem.get(node.id) ?? 0;
      node.children.forEach(walk);
    };
    walk(root);
    trees[id] = { root, totals, spendUsd };
  }
  return trees;
}

/** Read one work item's subtree. The batch implementation is the source of
 *  truth so the additive batch route stays byte-for-byte shape-compatible. */
export function getWorkItemTree(id: string): WorkItemTree | undefined {
  return getWorkItemTrees([id])[id];
}

export interface UpdateWorkItemInput {
  title?: string;
  body?: string | null;
  assignee?: string | null;
  department?: string | null;
  priority?: number;
  rank?: number | null;
  /** Todos v2 slice 4 — the widened metadata pen also covers these. */
  acceptance?: string | null;
  dueAt?: string | null;
  /** Todos v2 slice 6 — the rail's verify picker (operator-only at the route).
   *  null clears to the provenance default. */
  verifyPolicy?: VerifyPolicy | null;
}

export interface ConditionalWorkItemUpdateOptions {
  expectedVersion: number;
  idempotencyKey?: string;
  actor?: string | null;
}

export interface ConditionalWorkItemUpdateResult {
  item: WorkItem;
  replayed: boolean;
}

export class WorkItemVersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super('Todo changed since it was loaded');
    this.name = 'WorkItemVersionConflictError';
    this.currentVersion = currentVersion;
  }
}

export class WorkItemIdempotencyConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super('Todo edit idempotency key was already used for a different request');
    this.name = 'WorkItemIdempotencyConflictError';
    this.currentVersion = currentVersion;
  }
}

const UPDATE_FIELD_COLUMNS: Readonly<Record<keyof UpdateWorkItemInput, string>> = {
  title: 'title',
  body: 'body',
  assignee: 'assignee',
  department: 'department',
  priority: 'priority',
  rank: 'rank',
  // Appended AFTER the original six so pre-slice-4 idempotency-receipt
  // fingerprints (key order feeds the canonical JSON) stay byte-stable.
  acceptance: 'acceptance',
  dueAt: 'due_at',
  // Slice 6, appended for the same fingerprint-stability reason.
  verifyPolicy: 'verify_policy',
};

/** SQL-storable value for one update field (verify_policy is a JSON column). */
function updateFieldSqlValue(input: UpdateWorkItemInput, key: keyof UpdateWorkItemInput): unknown {
  if (key === 'verifyPolicy') return input.verifyPolicy ? JSON.stringify(input.verifyPolicy) : null;
  return input[key];
}

function canonicalUpdateFingerprint(id: string, input: UpdateWorkItemInput, expectedVersion: number): string {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(UPDATE_FIELD_COLUMNS) as Array<keyof UpdateWorkItemInput>) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  return createHash('sha256').update(JSON.stringify({ id, expectedVersion, patch })).digest('hex');
}

function idempotencyKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function updateChangesItem(item: WorkItem, input: UpdateWorkItemInput): boolean {
  return (Object.keys(UPDATE_FIELD_COLUMNS) as Array<keyof UpdateWorkItemInput>)
    .some((key) => {
      if (input[key] === undefined) return false;
      if (key === 'verifyPolicy') return JSON.stringify(item.verifyPolicy) !== JSON.stringify(input.verifyPolicy);
      return item[key] !== input[key];
    });
}

/** Atomic row-level compare-and-update for the operator metadata surface.
 * Partial fields are patch semantics, but `expectedVersion` protects the whole
 * Todo row: any intervening editable or lifecycle mutation conflicts. An exact
 * idempotency replay is resolved before that guard and never writes again. */
export function updateWorkItemConditional(
  id: string,
  input: UpdateWorkItemInput,
  opts: ConditionalWorkItemUpdateOptions,
): ConditionalWorkItemUpdateResult | undefined {
  const db = initDb();
  const fingerprint = canonicalUpdateFingerprint(id, input, opts.expectedVersion);
  const keyDigest = opts.idempotencyKey ? idempotencyKeyDigest(opts.idempotencyKey) : undefined;
  const txn = db.transaction((): ConditionalWorkItemUpdateResult | undefined => {
    const current = getWorkItem(id);
    if (!current) return undefined;

    if (keyDigest) {
      const receipt = db
        .prepare('SELECT request_fingerprint FROM work_item_edit_receipts WHERE key_digest = ?')
        .get(keyDigest) as { request_fingerprint: string } | undefined;
      if (receipt) {
        if (receipt.request_fingerprint !== fingerprint) {
          throw new WorkItemIdempotencyConflictError(current.version);
        }
        return { item: current, replayed: true };
      }
    }

    if (current.version !== opts.expectedVersion) {
      throw new WorkItemVersionConflictError(current.version);
    }

    let item = current;
    if (updateChangesItem(current, input)) {
      const fields = (Object.keys(UPDATE_FIELD_COLUMNS) as Array<keyof UpdateWorkItemInput>)
        .filter((key) => input[key] !== undefined)
        .map((key) => ({ column: UPDATE_FIELD_COLUMNS[key], name: key, value: updateFieldSqlValue(input, key) }));
      if (typeof input.department === 'string') ensureDepartmentRegistered(input.department);
      const now = new Date().toISOString();
      const result = db
        .prepare(`UPDATE work_items SET ${fields.map((field) => `${field.column} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`)
        .run(...fields.map((field) => field.value), now, id, opts.expectedVersion);
      if (result.changes === 0) {
        const latest = getWorkItem(id);
        if (!latest) return undefined;
        throw new WorkItemVersionConflictError(latest.version);
      }
      appendWorkItemEvent({
        workItemId: id,
        kind: 'metadata_edited',
        actor: opts.actor ?? null,
        detail: { updatedFields: fields.map((field) => field.name) },
        versionEffect: 'companion',
      });
      item = getWorkItem(id)!;
    }

    if (keyDigest) {
      db.prepare(
        `INSERT INTO work_item_edit_receipts (key_digest, request_fingerprint, result_version, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(keyDigest, fingerprint, item.version, new Date().toISOString());
    }
    return { item, replayed: false };
  });
  return txn.immediate();
}

/** Internal compatibility write for migration and trusted non-HTTP callers.
 * Public operator edits use updateWorkItemConditional. Status is deliberately
 * absent: lifecycle changes belong to the guarded transitions module. */
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
    const current = getWorkItem(id);
    if (!current) return undefined;
    const changedFields = fields.filter((field) => current[field.name] !== field.value);
    if (changedFields.length === 0) return current;
    if (changedFields.some((field) => field.name === 'department' && typeof field.value === 'string')) {
      ensureDepartmentRegistered(input.department as string);
    }
    const now = new Date().toISOString();
    const result = db
      .prepare(`UPDATE work_items SET ${changedFields.map((field) => `${field.column} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(...changedFields.map((field) => field.value), now, id);
    if (result.changes === 0) return undefined;
    appendWorkItemEvent({
      workItemId: id,
      kind: 'note',
      actor: actor ?? null,
      detail: { updatedFields: changedFields.map((field) => field.name) },
      versionEffect: 'companion',
    });
    return getWorkItem(id);
  });
  return txn();
}

/** Live spend over an item's execution attempts: `SUM(total_cost)` across linked
 *  sessions. Never stored (design §1.6) — always derived, never stale. */
export function getWorkItemSpend(id: string): number {
  const db = initDb();
  const workItemId = parseTodoId(id);
  const row = db
    .prepare('SELECT COALESCE(SUM(total_cost), 0) AS spend FROM sessions WHERE work_item_id = ?')
    .get(workItemId) as { spend: number };
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
  const todoId = parseTodoId(workItemId);
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    const session = db
      .prepare('SELECT work_item_id FROM sessions WHERE id = ?')
      .get(sessionId) as { work_item_id: string | null } | undefined;
    if (!session) throw new Error(`linkSession: session ${sessionId} not found`);
    const workItemExists = db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(todoId);
    if (!workItemExists) throw new Error(`linkSession: work item ${todoId} not found`);
    // Already linked to this exact item → no write, no `updated_at` bump.
    if (session.work_item_id === todoId) return;
    db.prepare('UPDATE sessions SET work_item_id = ? WHERE id = ?').run(todoId, sessionId);
    db.prepare('UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, todoId);
    appendWorkItemEvent({ workItemId: todoId, kind: 'session_linked', detail: { sessionId } });
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
    .prepare(`UPDATE work_items SET status = ?, updated_at = ?, version = version + 1${closedClause} WHERE id = ?${guardClause}`)
    .run(...params);
  if (result.changes === 0) return undefined;
  return getWorkItem(id);
}
