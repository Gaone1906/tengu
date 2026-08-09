import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import {
  resolveTodoIdPrefix,
  parseTodoIdPrefix,
  formatTodoId,
  isTodoId,
  todoIdOrdinal,
  todoIdPrefix,
  TODO_ID_PREFIX_PATTERN,
} from "./id.js";
import { resolveDepartmentPrefix } from "./departments.js";
import { loadConfig } from "../shared/config.js";
import { CONFIG_PATH } from "../shared/paths.js";

export const UNSUPPORTED_PRERELEASE_TODO_DATA =
  "Unsupported prerelease Todo data detected. This release cannot start or migrate it.\n" +
  "Use the separately reviewed offline converter, or restore a supported public-version backup.";

export const CORRUPT_SESSIONS_DATABASE =
  "The session database appears to be corrupt or is not a valid SQLite file — this is NOT a Todo-data\n" +
  "problem. Restore it from a backup (check the 'backups/' folder next to registry.db, or your most\n" +
  "recent copy) and restart.";

/** File-copy backup suffix written next to the registry before a v1→v2 rebuild. */
export const WORK_ITEMS_BACKUP_SUFFIX = ".pre-todos-v2";

/** SQLite surfaces file corruption via these substrings. */
function isSqliteCorruption(message: string): boolean {
  return /malformed|file is not a database|not a database|disk image is malformed|database is locked.*corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(
    message,
  );
}

const CANONICAL_ID_SQL = `
  id GLOB '[A-Z][A-Z][A-Z]-[1-9]*'
  AND substr(id, 5) NOT GLOB '*[^0-9]*'
  AND CAST(substr(id, 5) AS INTEGER) BETWEEN 1 AND 9007199254740991
  AND printf('%lld', CAST(substr(id, 5) AS INTEGER)) = substr(id, 5)
`;

/* ── Frozen v1 schema (recognizer for pre-migration databases) ─────────────── */

/** v1 (first public Todo release) work_items shape, byte-identical to what it
 *  installed — the v1→v2 migration recognizes existing databases against it. */
export const V1_WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (${CANONICAL_ID_SQL}),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source              TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref          TEXT,
  acceptance          TEXT,
  verify_policy       TEXT,
  rounds              INTEGER NOT NULL DEFAULT 0,
  budget_usd          REAL,
  approval_state      TEXT CHECK (approval_state IN ('pending','approved','rejected')),
  approval_request    TEXT,
  approval_ref        TEXT,
  approval_target     TEXT,
  approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT,
  approval_decided_by TEXT,
  approval_decided_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
)`;

export const V1_WORK_ITEM_ID_ALLOCATOR_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_allocator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  prefix TEXT CHECK (prefix IS NULL OR (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]')),
  high_water INTEGER NOT NULL CHECK (high_water BETWEEN 0 AND 9007199254740991)
)
`;

export const V1_WORK_ITEM_ID_BURNS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_burns (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  claim_digest TEXT NOT NULL UNIQUE CHECK (length(claim_digest) = 64 AND claim_digest NOT GLOB '*[^0-9a-f]*'),
  burned_at TEXT NOT NULL
)
`;

export const V1_WORK_ITEM_ID_ISSUANCES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_issuances (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  issued_at TEXT NOT NULL
)
`;

export const V1_WORK_ITEM_IDENTITY_TABLES_DDL = `
${V1_WORK_ITEM_ID_ALLOCATOR_TABLE_DDL};
INSERT INTO work_item_id_allocator (singleton, prefix, high_water)
  SELECT 1, NULL, 0 WHERE NOT EXISTS (SELECT 1 FROM work_item_id_allocator);
${V1_WORK_ITEM_ID_BURNS_TABLE_DDL};
${V1_WORK_ITEM_ID_ISSUANCES_TABLE_DDL};
`;

/* ── Current (v2) schema — Todos v2 slice 1 ────────────────────────────────── */

/** v2 (Todos v2 slice 1) shape, frozen exactly as it shipped before the
 *  `phase` column landed (docs/tengu/18-council-specialists.md, D21) — the
 *  recognizer `recognizedHealableV2` matches against to heal an existing
 *  database in place (`ALTER TABLE ... ADD COLUMN phase`), same role as
 *  `V2_APPROVAL_WORK_ITEMS_TABLE_DDL` for the approval-column drop. */
export const PRE_PHASE_WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (${CANONICAL_ID_SQL}),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  created_by          TEXT NOT NULL,
  parent_id           TEXT REFERENCES work_items(id),
  root_id             TEXT NOT NULL,
  depth               INTEGER NOT NULL DEFAULT 0 CHECK ((parent_id IS NULL AND depth = 0) OR (parent_id IS NOT NULL AND depth BETWEEN 1 AND 3)),
  due_at              TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source              TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref          TEXT,
  acceptance          TEXT,
  verify_policy       TEXT,
  rounds              INTEGER NOT NULL DEFAULT 0,
  budget_usd          REAL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
)`;

/** v2 (Todos v2 slice 1): per-department prefixes + sub-task tree columns.
 *  `phase` (docs/tengu/18-council-specialists.md, D21) is a plain label on the
 *  tree, exactly parallel to `department` — a per-project vocabulary, not a
 *  new depth. It is appended LAST, not next to `department`, AND its comma
 *  sits on the line BELOW `closed_at` rather than trailing it: SQLite's
 *  `ALTER TABLE ... ADD COLUMN` (the healing path for an existing database)
 *  splices `, phase TEXT` in literally, immediately before the closing paren,
 *  with no comma of its own on the preceding line and no space before that
 *  paren. This exact layout is the only one a fresh CREATE and a healed ALTER
 *  agree on byte-for-byte once `sqlShape` collapses whitespace runs — it does
 *  NOT reorder text, so a comma's position relative to it still matters. */
export const WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (${CANONICAL_ID_SQL}),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  created_by          TEXT NOT NULL,
  parent_id           TEXT REFERENCES work_items(id),
  root_id             TEXT NOT NULL,
  depth               INTEGER NOT NULL DEFAULT 0 CHECK ((parent_id IS NULL AND depth = 0) OR (parent_id IS NOT NULL AND depth BETWEEN 1 AND 3)),
  due_at              TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source              TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref          TEXT,
  acceptance          TEXT,
  verify_policy       TEXT,
  rounds              INTEGER NOT NULL DEFAULT 0,
  budget_usd          REAL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
, phase TEXT)`;

/** Pre-PLA-48 v2 work_items shape, when approvals were also shadowed in eight
 *  columns here. Frozen recognizer: a match is healed at boot. */
export const V2_APPROVAL_WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (${CANONICAL_ID_SQL}),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  created_by          TEXT NOT NULL,
  parent_id           TEXT REFERENCES work_items(id),
  root_id             TEXT NOT NULL,
  depth               INTEGER NOT NULL DEFAULT 0 CHECK ((parent_id IS NULL AND depth = 0) OR (parent_id IS NOT NULL AND depth BETWEEN 1 AND 3)),
  due_at              TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source              TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref          TEXT,
  acceptance          TEXT,
  verify_policy       TEXT,
  rounds              INTEGER NOT NULL DEFAULT 0,
  budget_usd          REAL,
  approval_state      TEXT CHECK (approval_state IN ('pending','approved','rejected')),
  approval_request    TEXT,
  approval_ref        TEXT,
  approval_target     TEXT,
  approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT,
  approval_decided_by TEXT,
  approval_decided_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
)`;

/** The shadow columns above, dropped once their values reach `work_item_approvals`. */
const V2_APPROVAL_COLUMNS: readonly string[] = ["approval_state", "approval_request", "approval_ref",
  "approval_target", "approval_target_kind", "approval_escalated_at", "approval_decided_by", "approval_decided_at"];

export const WORK_ITEMS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_work_items_status     ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_department ON work_items(department);
CREATE INDEX IF NOT EXISTS idx_work_items_phase      ON work_items(phase);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_items_source_ref
  ON work_items(source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_items_recent     ON work_items(updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_items_default_order
  ON work_items((rank IS NULL), rank, updated_at DESC, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_work_items_manual_order
  ON work_items(status, (rank IS NULL), rank, updated_at DESC, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_work_items_parent     ON work_items(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_items_root       ON work_items(root_id);
CREATE INDEX IF NOT EXISTS idx_work_items_created_by ON work_items(created_by, (parent_id IS NULL), updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_items_due        ON work_items(due_at) WHERE due_at IS NOT NULL;
`;

export const WORK_ITEM_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_events (
  id           TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL CHECK (${CANONICAL_ID_SQL.replaceAll("id", "work_item_id")}),
  kind         TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  actor        TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL
)
`;

export const WORK_ITEM_EVENTS_DDL = `
${WORK_ITEM_EVENTS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_wi_events_item ON work_item_events(work_item_id, created_at);
`;

/** Todos v2 slice 2: threaded, mutable discussion layer. Delete = tombstone
 *  (body cleared, row retained) so thread shape survives; `work_item_events`
 *  stays the pure machine audit and records comment activity separately. */
export const WORK_ITEM_COMMENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_comments (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'wic_[0-9a-f]*' AND length(id) = 16),
  work_item_id      TEXT NOT NULL REFERENCES work_items(id),
  parent_comment_id TEXT REFERENCES work_item_comments(id),
  author_kind       TEXT NOT NULL CHECK (author_kind IN ('operator','employee','system')),
  author            TEXT NOT NULL,
  body              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  edited_at         TEXT,
  deleted_at        TEXT
)`;

export const WORK_ITEM_COMMENTS_DDL = `
${WORK_ITEM_COMMENTS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_wi_comments_item ON work_item_comments(work_item_id, created_at);
`;

/** Todos v2 slice 3: typed item-to-item relations. `blocks`/`duplicates` are
 *  directional; `relates` is symmetric and stored ONCE in canonical order
 *  (lexicographically smaller Todo id as src_id). The DAG guarantee on `blocks`
 *  is enforced by the write path's in-transaction cycle check and re-verified
 *  at boot. */
export const WORK_ITEM_RELATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_relations (
  src_id     TEXT NOT NULL REFERENCES work_items(id),
  dst_id     TEXT NOT NULL REFERENCES work_items(id),
  kind       TEXT NOT NULL CHECK (kind IN ('blocks','relates','duplicates')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_id, kind),
  CHECK (src_id <> dst_id)
)`;

export const WORK_ITEM_RELATIONS_DDL = `
${WORK_ITEM_RELATIONS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_wi_relations_dst ON work_item_relations(dst_id, kind);
`;

/** Todos v2 slice 3: shared label registry. `name` is normalized lowercase
 *  kebab-case; `department` NULL = company-wide. */
export const LABELS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS labels (
  id         TEXT PRIMARY KEY CHECK (id GLOB 'lbl_[0-9a-f]*' AND length(id) = 16),
  name       TEXT NOT NULL UNIQUE,
  color      TEXT CHECK (color IS NULL OR color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'),
  department TEXT,
  created_at TEXT NOT NULL
)`;

export const LABELS_DDL = `${LABELS_TABLE_DDL};`;

export const WORK_ITEM_LABELS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_labels (
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  label_id     TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (work_item_id, label_id)
)`;

export const WORK_ITEM_LABELS_DDL = `${WORK_ITEM_LABELS_TABLE_DDL};`;

/** Todos v2 slice 5: content-addressed file attachments on Todos and comments.
 *  Bytes live at `<instance>/attachments/<sha256[0:2]>/<sha256>` (dedup by
 *  content); `storage_path` stores the RELATIVE form. `comment_id` NULL =
 *  attached to the Todo itself; set = attached to that comment (which must
 *  belong to the same item — enforced in the store write and re-proven by the
 *  verifier). The sha256 hex shape is a verifier concern (the DDL pins only the
 *  length, matching spec §3.2). */
export const WORK_ITEM_ATTACHMENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_attachments (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'wia_[0-9a-f]*' AND length(id) = 16),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  comment_id   TEXT REFERENCES work_item_comments(id),
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  bytes        INTEGER NOT NULL CHECK (bytes > 0),
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  storage_path TEXT NOT NULL,
  uploaded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL
)`;

export const WORK_ITEM_ATTACHMENTS_DDL = `
${WORK_ITEM_ATTACHMENTS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_wia_item ON work_item_attachments(work_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wia_comment ON work_item_attachments(comment_id) WHERE comment_id IS NOT NULL;
`;

/** Todos v2 slice 4: approvals leave the fat work_items row. The SOLE storage
 *  owner since PLA-48 — full history, one row per requested gate; the partial
 *  unique index makes "at most one PENDING approval per item" a DB guarantee.
 *  `ref` is the opaque correlation reference the request contract has always
 *  carried (kept here so the `approvalRef` payload field stays byte-identical). */
export const WORK_ITEM_APPROVALS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_approvals (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'wap_[0-9a-f]*' AND length(id) = 16),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  state        TEXT NOT NULL CHECK (state IN ('pending','approved','rejected')),
  request      TEXT NOT NULL,
  ref          TEXT,
  target       TEXT,
  target_kind  TEXT CHECK (target_kind IN ('employee','virtual','none')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  escalated_at TEXT,
  decided_by   TEXT,
  decided_at   TEXT,
  note         TEXT
)`;

export const WORK_ITEM_APPROVALS_DDL = `
${WORK_ITEM_APPROVALS_TABLE_DDL};
CREATE UNIQUE INDEX IF NOT EXISTS uq_wap_pending ON work_item_approvals(work_item_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_wap_item ON work_item_approvals(work_item_id, requested_at);
`;

/** Variant-picking approvals: the offered options and the picked one, 1:1 with
 *  an approval row. A separate table rather than two `work_item_approvals`
 *  columns because `verifyCurrentWorkItemSchema` refuses ANY shape drift on an
 *  existing table, while a MISSING additive table heals cleanly on boot — so a
 *  new table is the only backward-compatible way to extend an approval.
 *  `options` is a JSON array of labels; `choice` is null until a pick lands. */
export const WORK_ITEM_APPROVAL_CHOICES_DDL = `
CREATE TABLE IF NOT EXISTS work_item_approval_choices (
  approval_id TEXT PRIMARY KEY REFERENCES work_item_approvals(id) ON DELETE CASCADE,
  options     TEXT NOT NULL,
  choice      TEXT
)`;

/** Gates reserved for the human operator: a row here means NO employee may
 *  decide this approval, not the COO and not through escalation. Presence IS the
 *  reservation, so there is no value to drift. A separate table for the same
 *  reason as `work_item_approval_choices`: `work_item_approvals.target_kind`
 *  carries a CHECK constraint the exact-shape preflight covers, so adding a
 *  value there would make every existing database refuse to boot. */
export const WORK_ITEM_APPROVAL_OPERATOR_ONLY_DDL = `
CREATE TABLE IF NOT EXISTS work_item_approval_operator_only (
  approval_id TEXT PRIMARY KEY REFERENCES work_item_approvals(id) ON DELETE CASCADE
)`;

/** Checkpointing (docs/tengu/10-checkpointing.md): the machine-checkable `verify`
 *  command for a depth-3 sub-sub-task checkpoint. A single current row per item
 *  (not append-only history like approvals/comments — a verify command is edited
 *  in place, and only its latest value is ever meaningful). Additive table, same
 *  reasoning as attachments/approvals: `work_items` is frozen exact-shape, so a
 *  new capability is a new table, not a new column. Depth-3-only is enforced at
 *  the write path (`work-items/store.ts`, `work-items/checkpoint.ts`), not here. */
export const WORK_ITEM_VERIFY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_verify (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  command      TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)`;

export const WORK_ITEM_VERIFY_DDL = `${WORK_ITEM_VERIFY_TABLE_DDL};`;

/** Fan-out planning gate (docs/tengu/07-fanout-policy.md, D8, Gate 1): the
 *  planner's `parallelSafe`/`parallelGroup` call on a sub-task. `parallelSafe`
 *  defaults to 0 (false) at the DB level too — an item with no row here is
 *  indistinguishable from one explicitly marked not-safe, matching the "must
 *  be affirmatively justified" design. Same additive-table reasoning as
 *  `work_item_verify`: `work_items` is frozen exact-shape. */
export const WORK_ITEM_FANOUT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_fanout (
  work_item_id   TEXT PRIMARY KEY REFERENCES work_items(id),
  parallel_safe  INTEGER NOT NULL DEFAULT 0 CHECK (parallel_safe IN (0, 1)),
  parallel_group TEXT,
  updated_at     TEXT NOT NULL
)`;

export const WORK_ITEM_FANOUT_DDL = `${WORK_ITEM_FANOUT_TABLE_DDL};`;

/** Project identity (docs/tengu/03-implementation-plan.md step 11, stand-up):
 *  a root work item (depth 0) IS a project, matching the existing one-root-
 *  per-outcome convention. `workspacePath` is the project's checkout path on
 *  disk — what the stand-up groups by and what a project card names itself
 *  after. Root-only is enforced at the write path (`work-items/store.ts`),
 *  re-proven at boot below. Same additive-table reasoning as verify/fanout:
 *  `work_items` is frozen exact-shape. */
export const WORK_ITEM_WORKSPACE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_workspace (
  work_item_id   TEXT PRIMARY KEY REFERENCES work_items(id),
  workspace_path TEXT NOT NULL,
  updated_at     TEXT NOT NULL
)`;

export const WORK_ITEM_WORKSPACE_DDL = `${WORK_ITEM_WORKSPACE_TABLE_DDL};`;

/** Profile registry (docs/tengu/18-council-specialists.md, D22): a user-
 *  defined namespace inside one running instance (work/personal/side-project/
 *  hobby/...) — modeled on `departments` minus the ID-prefix machinery, since
 *  a profile never drives a Todo ID. */
export const PROFILES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY CHECK (id GLOB 'prf_[0-9a-f]*' AND length(id) = 16),
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  color      TEXT CHECK (color IS NULL OR color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'),
  created_at TEXT NOT NULL
)`;

export const PROFILES_DDL = `${PROFILES_TABLE_DDL};`;

/** Profile overlay (D22): which profile a root Todo belongs to, modeled
 *  byte-for-byte on `work_item_workspace` above — one current row per item,
 *  edited in place. Root-only is enforced at the write path
 *  (`work-items/store.ts`), re-proven at boot below. */
export const WORK_ITEM_PROFILE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_profile (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  profile_id   TEXT NOT NULL REFERENCES profiles(id),
  updated_at   TEXT NOT NULL
)`;

export const WORK_ITEM_PROFILE_DDL = `${WORK_ITEM_PROFILE_TABLE_DDL};`;

/** Per-project phase vocabulary (docs/tengu/18-council-specialists.md, D21):
 *  `phase` on `work_items` stays a plain label, exactly parallel to
 *  `department` — this registers the vocabulary for ONE project (`root_id`),
 *  not company-wide the way `departments` is. Root-only is enforced at the
 *  write path (`work-items/store.ts`, `work-items/phases.ts`), re-proven at
 *  boot below. */
export const WORK_ITEM_PHASES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_phases (
  root_id        TEXT NOT NULL REFERENCES work_items(id),
  slug           TEXT NOT NULL,
  sequence_order INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (root_id, slug)
)`;

export const WORK_ITEM_PHASES_DDL = `
${WORK_ITEM_PHASES_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_wi_phases_root ON work_item_phases(root_id, sequence_order);
`;

export const WORK_ITEM_EDIT_RECEIPTS_DDL = `
CREATE TABLE IF NOT EXISTS work_item_edit_receipts (
  key_digest          TEXT PRIMARY KEY CHECK (length(key_digest) = 64),
  request_fingerprint TEXT NOT NULL,
  result_version      INTEGER NOT NULL CHECK (result_version >= 1),
  created_at          TEXT NOT NULL
);
`;

export const WORK_ITEM_ID_ALLOCATOR_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_allocator (
  prefix TEXT PRIMARY KEY CHECK (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]'),
  high_water INTEGER NOT NULL CHECK (high_water BETWEEN 0 AND 9007199254740991)
)`;

export const WORK_ITEM_ID_BURNS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_burns (
  prefix TEXT NOT NULL CHECK (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]'),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  claim_digest TEXT NOT NULL UNIQUE CHECK (length(claim_digest) = 64 AND claim_digest NOT GLOB '*[^0-9a-f]*'),
  burned_at TEXT NOT NULL,
  PRIMARY KEY (prefix, ordinal)
)`;

export const WORK_ITEM_ID_ISSUANCES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_issuances (
  prefix TEXT NOT NULL CHECK (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]'),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  issued_at TEXT NOT NULL,
  PRIMARY KEY (prefix, ordinal)
)`;

export const DEPARTMENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS departments (
  slug TEXT PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE CHECK (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]'),
  created_at TEXT NOT NULL
)`;

export const WORK_ITEM_IDENTITY_TABLES_DDL = `
${WORK_ITEM_ID_ALLOCATOR_TABLE_DDL};
${WORK_ITEM_ID_BURNS_TABLE_DDL};
${WORK_ITEM_ID_ISSUANCES_TABLE_DDL};
${DEPARTMENTS_TABLE_DDL};
`;

export const WORK_ITEM_ID_IMMUTABLE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS work_items_id_immutable
BEFORE UPDATE OF id ON work_items
BEGIN
  SELECT RAISE(ABORT, 'Todo ID is immutable');
END`;

/* ── Identity triggers ─────────────────────────────────────────────────────── */

/** Frozen v1 trigger set (singleton allocator) — fixture builders + recognition only. */
const V1_WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_no_insert
BEFORE INSERT ON work_item_id_allocator
WHEN EXISTS (SELECT 1 FROM work_item_id_allocator)
BEGIN SELECT RAISE(ABORT, 'Todo allocator is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_guard_update
BEFORE UPDATE ON work_item_id_allocator
WHEN NEW.singleton != OLD.singleton
  OR NEW.high_water != OLD.high_water + 1
  OR jinn_work_item_claim_prefix() IS NULL
  OR NEW.prefix != COALESCE(OLD.prefix, jinn_work_item_claim_prefix())
  OR (OLD.prefix IS NOT NULL AND NEW.prefix != OLD.prefix)
  OR jinn_work_item_claim_digest() IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns
    WHERE ordinal = NEW.high_water AND claim_digest = jinn_work_item_claim_digest()
  )
BEGIN SELECT RAISE(ABORT, 'Todo allocator mutation refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_no_delete
BEFORE DELETE ON work_item_id_allocator
BEGIN SELECT RAISE(ABORT, 'Todo allocator is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_guard_insert
BEFORE INSERT ON work_item_id_burns
WHEN NEW.ordinal != (SELECT high_water + 1 FROM work_item_id_allocator WHERE singleton = 1)
  OR jinn_work_item_claim_digest() IS NULL
  OR NEW.claim_digest != jinn_work_item_claim_digest()
BEGIN SELECT RAISE(ABORT, 'Todo burn claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_no_update
BEFORE UPDATE ON work_item_id_burns
BEGIN SELECT RAISE(ABORT, 'Todo burn ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_no_delete
BEFORE DELETE ON work_item_id_burns
BEGIN SELECT RAISE(ABORT, 'Todo burn ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_guard_insert
BEFORE INSERT ON work_item_id_issuances
WHEN jinn_work_item_claim_digest() IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns b
    JOIN work_items w ON CAST(substr(w.id, 5) AS INTEGER) = b.ordinal
    WHERE b.ordinal = NEW.ordinal AND b.claim_digest = jinn_work_item_claim_digest()
  )
BEGIN SELECT RAISE(ABORT, 'Todo issuance claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_no_update
BEFORE UPDATE ON work_item_id_issuances
BEGIN SELECT RAISE(ABORT, 'Todo issuance ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_no_delete
BEFORE DELETE ON work_item_id_issuances
BEGIN SELECT RAISE(ABORT, 'Todo issuance ledger is append-only'); END`,
  WORK_ITEM_ID_IMMUTABLE_TRIGGER_SQL,
  `CREATE TRIGGER IF NOT EXISTS work_items_claim_required
BEFORE INSERT ON work_items
WHEN jinn_work_item_claim_digest() IS NULL
  OR jinn_work_item_claim_prefix() IS NULL
  OR substr(NEW.id, 1, 3) != (SELECT prefix FROM work_item_id_allocator WHERE singleton = 1)
  OR substr(NEW.id, 1, 3) != jinn_work_item_claim_prefix()
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns b
    WHERE b.ordinal = CAST(substr(NEW.id, 5) AS INTEGER)
      AND b.claim_digest = jinn_work_item_claim_digest()
  )
  OR EXISTS (
    SELECT 1 FROM work_item_id_issuances i
    WHERE i.ordinal = CAST(substr(NEW.id, 5) AS INTEGER)
  )
BEGIN SELECT RAISE(ABORT, 'Todo allocation claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_items_mark_issued
AFTER INSERT ON work_items
BEGIN
  INSERT INTO work_item_id_issuances (ordinal, issued_at)
  VALUES (CAST(substr(NEW.id, 5) AS INTEGER), NEW.created_at);
END`,
];

export const V1_WORK_ITEM_IDENTITY_TRIGGERS_DDL =
  V1_WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS.map((statement) => `${statement};`).join("\n");

/** One statement per entry. The installed DDL and the startup verifier's expected SQL are both
 *  derived from this list, so a trigger body can never drift out of the schema it is checked against. */
const WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_guard_insert
BEFORE INSERT ON work_item_id_allocator
WHEN NEW.high_water != 0
BEGIN SELECT RAISE(ABORT, 'Todo allocator namespaces start at zero'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_guard_update
BEFORE UPDATE ON work_item_id_allocator
WHEN NEW.prefix != OLD.prefix
  OR NEW.high_water != OLD.high_water + 1
  OR jinn_work_item_claim_prefix() IS NULL
  OR NEW.prefix != jinn_work_item_claim_prefix()
  OR jinn_work_item_claim_digest() IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns
    WHERE prefix = NEW.prefix AND ordinal = NEW.high_water
      AND claim_digest = jinn_work_item_claim_digest()
  )
BEGIN SELECT RAISE(ABORT, 'Todo allocator mutation refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_allocator_no_delete
BEFORE DELETE ON work_item_id_allocator
BEGIN SELECT RAISE(ABORT, 'Todo allocator is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_guard_insert
BEFORE INSERT ON work_item_id_burns
WHEN NEW.ordinal IS NOT (SELECT high_water + 1 FROM work_item_id_allocator WHERE prefix = NEW.prefix)
  OR jinn_work_item_claim_digest() IS NULL
  OR NEW.claim_digest != jinn_work_item_claim_digest()
  OR jinn_work_item_claim_prefix() IS NULL
  OR NEW.prefix != jinn_work_item_claim_prefix()
BEGIN SELECT RAISE(ABORT, 'Todo burn claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_no_update
BEFORE UPDATE ON work_item_id_burns
BEGIN SELECT RAISE(ABORT, 'Todo burn ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_burn_no_delete
BEFORE DELETE ON work_item_id_burns
BEGIN SELECT RAISE(ABORT, 'Todo burn ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_guard_insert
BEFORE INSERT ON work_item_id_issuances
WHEN jinn_work_item_claim_digest() IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns b
    JOIN work_items w ON w.id = NEW.prefix || '-' || NEW.ordinal
    WHERE b.prefix = NEW.prefix AND b.ordinal = NEW.ordinal
      AND b.claim_digest = jinn_work_item_claim_digest()
  )
BEGIN SELECT RAISE(ABORT, 'Todo issuance claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_no_update
BEFORE UPDATE ON work_item_id_issuances
BEGIN SELECT RAISE(ABORT, 'Todo issuance ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_issuance_no_delete
BEFORE DELETE ON work_item_id_issuances
BEGIN SELECT RAISE(ABORT, 'Todo issuance ledger is append-only'); END`,
  WORK_ITEM_ID_IMMUTABLE_TRIGGER_SQL,
  `CREATE TRIGGER IF NOT EXISTS work_items_claim_required
BEFORE INSERT ON work_items
WHEN jinn_work_item_claim_digest() IS NULL
  OR jinn_work_item_claim_prefix() IS NULL
  OR substr(NEW.id, 1, 3) != jinn_work_item_claim_prefix()
  OR NOT EXISTS (
    SELECT 1 FROM work_item_id_burns b
    WHERE b.prefix = substr(NEW.id, 1, 3)
      AND b.ordinal = CAST(substr(NEW.id, 5) AS INTEGER)
      AND b.claim_digest = jinn_work_item_claim_digest()
  )
  OR EXISTS (
    SELECT 1 FROM work_item_id_issuances i
    WHERE i.prefix = substr(NEW.id, 1, 3) AND i.ordinal = CAST(substr(NEW.id, 5) AS INTEGER)
  )
BEGIN SELECT RAISE(ABORT, 'Todo allocation claim refused'); END`,
  `CREATE TRIGGER IF NOT EXISTS work_items_mark_issued
AFTER INSERT ON work_items
BEGIN
  INSERT INTO work_item_id_issuances (prefix, ordinal, issued_at)
  VALUES (substr(NEW.id, 1, 3), CAST(substr(NEW.id, 5) AS INTEGER), NEW.created_at);
END`,
];

export const WORK_ITEM_IDENTITY_TRIGGERS_DDL =
  WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS.map((statement) => `${statement};`).join("\n");

const REQUIRED_TRIGGER_SQL = new Map<string, string>(
  WORK_ITEM_IDENTITY_TRIGGER_STATEMENTS.map((statement) => {
    const name = /^CREATE TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i.exec(statement)?.[1];
    if (!name) throw new Error("unnamed Todo identity trigger");
    return [name, statement] as const;
  }),
);

const activeClaims = new WeakMap<DatabaseType, string>();
const activeClaimPrefixes = new WeakMap<DatabaseType, string>();
const registeredDatabases = new WeakSet<DatabaseType>();

function claimDigest(rawClaim: string): string {
  return createHash("sha256").update(rawClaim).digest("hex");
}

export function registerWorkItemIdentityFunctions(db: DatabaseType): void {
  if (registeredDatabases.has(db)) return;
  db.function("jinn_work_item_claim_digest", () => {
    const claim = activeClaims.get(db);
    return claim ? claimDigest(claim) : null;
  });
  db.function("jinn_work_item_claim_prefix", () => activeClaimPrefixes.get(db) ?? null);
  registeredDatabases.add(db);
}

function withClaim<T>(db: DatabaseType, rawClaim: string, prefix: string, fn: () => T): T {
  if (activeClaims.has(db)) throw new Error("nested Todo allocation claim");
  activeClaims.set(db, rawClaim);
  activeClaimPrefixes.set(db, prefix);
  try {
    return fn();
  } finally {
    activeClaims.delete(db);
    activeClaimPrefixes.delete(db);
  }
}

export interface WorkItemAllocationClaim {
  id: string;
  prefix: string;
  ordinal: number;
  /** One-time raw claim. It is never persisted. */
  rawClaim: string;
}

/** Commit the burn independently; a later failed create permanently leaves a gap. */
export function allocateWorkItemId(
  db: DatabaseType,
  now = new Date().toISOString(),
  prefix: string = "JIN",
): WorkItemAllocationClaim {
  registerWorkItemIdentityFunctions(db);
  parseTodoIdPrefix(prefix);
  const rawClaim = randomBytes(32).toString("hex");
  const allocation = db.transaction(() => {
    db.prepare(
      "INSERT INTO work_item_id_allocator (prefix, high_water) SELECT ?, 0 WHERE NOT EXISTS (SELECT 1 FROM work_item_id_allocator WHERE prefix = ?)",
    ).run(prefix, prefix);
    const current = db.prepare("SELECT high_water FROM work_item_id_allocator WHERE prefix = ?")
      .get(prefix) as { high_water: number };
    const next = current.high_water + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Todo ID allocator exhausted");
    return withClaim(db, rawClaim, prefix, () => {
      db.prepare("INSERT INTO work_item_id_burns (prefix, ordinal, claim_digest, burned_at) VALUES (?, ?, ?, ?)")
        .run(prefix, next, claimDigest(rawClaim), now);
      db.prepare("UPDATE work_item_id_allocator SET high_water = ? WHERE prefix = ?").run(next, prefix);
      return { prefix, ordinal: next };
    });
  }).immediate();
  return { id: formatTodoId(allocation.prefix, allocation.ordinal), ...allocation, rawClaim };
}

/** @internal test fixture builder — v1 semantics, do not use in product code. */
export function allocateWorkItemIdV1ForTest(
  db: DatabaseType,
  now = new Date().toISOString(),
  companyName: unknown = "Jinn",
  companyPrefix?: unknown,
): WorkItemAllocationClaim {
  registerWorkItemIdentityFunctions(db);
  const rawClaim = randomBytes(32).toString("hex");
  const allocation = db.transaction(() => {
    const current = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator WHERE singleton = 1")
      .get() as { prefix: string | null; high_water: number };
    const prefix = current.prefix ?? resolveTodoIdPrefix(companyName, companyPrefix);
    const next = current.high_water + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Todo ID allocator exhausted");
    return withClaim(db, rawClaim, prefix, () => {
      db.prepare("INSERT INTO work_item_id_burns (ordinal, claim_digest, burned_at) VALUES (?, ?, ?)")
        .run(next, claimDigest(rawClaim), now);
      db.prepare("UPDATE work_item_id_allocator SET prefix = ?, high_water = ? WHERE singleton = 1")
        .run(prefix, next);
      return { prefix, ordinal: next };
    });
  }).immediate();
  return { id: formatTodoId(allocation.prefix, allocation.ordinal), ...allocation, rawClaim };
}

export function useWorkItemAllocationClaim<T>(db: DatabaseType, claim: WorkItemAllocationClaim, fn: () => T): T {
  return withClaim(db, claim.rawClaim, claim.prefix, fn);
}

export type WorkItemSchemaPreflight = "absent" | "empty-prerelease" | "v1" | "current";

function sqlShape(sql: string | null | undefined): string {
  return (sql ?? "")
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

const REQUIRED_TABLE_SQL = new Map<string, string>([
  ["work_items", WORK_ITEMS_TABLE_DDL],
  ["work_item_events", WORK_ITEM_EVENTS_TABLE_DDL],
  ["work_item_comments", WORK_ITEM_COMMENTS_TABLE_DDL],
  ["work_item_relations", WORK_ITEM_RELATIONS_TABLE_DDL],
  ["labels", LABELS_TABLE_DDL],
  ["work_item_labels", WORK_ITEM_LABELS_TABLE_DDL],
  ["work_item_approvals", WORK_ITEM_APPROVALS_TABLE_DDL],
  ["work_item_approval_choices", WORK_ITEM_APPROVAL_CHOICES_DDL],
  ["work_item_approval_operator_only", WORK_ITEM_APPROVAL_OPERATOR_ONLY_DDL],
  ["work_item_attachments", WORK_ITEM_ATTACHMENTS_TABLE_DDL],
  ["work_item_verify", WORK_ITEM_VERIFY_TABLE_DDL],
  ["work_item_fanout", WORK_ITEM_FANOUT_TABLE_DDL],
  ["work_item_workspace", WORK_ITEM_WORKSPACE_TABLE_DDL],
  ["profiles", PROFILES_TABLE_DDL],
  ["work_item_profile", WORK_ITEM_PROFILE_TABLE_DDL],
  ["work_item_phases", WORK_ITEM_PHASES_TABLE_DDL],
  ["work_item_edit_receipts", WORK_ITEM_EDIT_RECEIPTS_DDL],
  ["work_item_id_allocator", WORK_ITEM_ID_ALLOCATOR_TABLE_DDL],
  ["work_item_id_burns", WORK_ITEM_ID_BURNS_TABLE_DDL],
  ["work_item_id_issuances", WORK_ITEM_ID_ISSUANCES_TABLE_DDL],
  ["departments", DEPARTMENTS_TABLE_DDL],
]);

/** Tables added additively AFTER the v2 rebuild first shipped, in ship order
 *  (comments = slice 2; relations/labels = slice 3; approvals = slice 4;
 *  attachments = slice 5). A v2
 *  database whose only defect is that some of these are absent is "current":
 *  `migrateWorkItemsSchema` creates whatever is missing under the write lock and
 *  the FULL exact-shape verify still gates the boot. A present-but-wrong-shape
 *  additive table is NOT recognized and refuses at preflight. */
const V2_ADDITIVE_TABLES: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "work_item_comments", ddl: WORK_ITEM_COMMENTS_DDL },
  { name: "work_item_relations", ddl: WORK_ITEM_RELATIONS_DDL },
  { name: "labels", ddl: LABELS_DDL },
  { name: "work_item_labels", ddl: WORK_ITEM_LABELS_DDL },
  { name: "work_item_approvals", ddl: WORK_ITEM_APPROVALS_DDL },
  { name: "work_item_approval_choices", ddl: WORK_ITEM_APPROVAL_CHOICES_DDL },
  { name: "work_item_approval_operator_only", ddl: WORK_ITEM_APPROVAL_OPERATOR_ONLY_DDL },
  { name: "work_item_attachments", ddl: WORK_ITEM_ATTACHMENTS_DDL },
  { name: "work_item_verify", ddl: WORK_ITEM_VERIFY_DDL },
  { name: "work_item_fanout", ddl: WORK_ITEM_FANOUT_DDL },
  { name: "work_item_workspace", ddl: WORK_ITEM_WORKSPACE_DDL },
  { name: "profiles", ddl: PROFILES_DDL },
  { name: "work_item_profile", ddl: WORK_ITEM_PROFILE_DDL },
  { name: "work_item_phases", ddl: WORK_ITEM_PHASES_DDL },
];

/**
 * Copy a shadow-column table's `approval_*` values into `work_item_approvals`,
 * one row per item carrying a state — a one-shot step inside each rebuild, and
 * a no-op for an item that already has an approval row. `requested_by`/
 * `requested_at` are not recoverable from the columns: `'legacy'` and the best
 * column-derived bound (decided_at when decided, else updated_at) stand in.
 */
function backfillWorkItemApprovals(db: DatabaseType, source: "work_items" | "work_items_v1_legacy"): number {
  return db
    .prepare(
      `INSERT INTO work_item_approvals
         (id, work_item_id, state, request, ref, target, target_kind, requested_by, requested_at, escalated_at, decided_by, decided_at, note)
       SELECT 'wap_' || lower(hex(randomblob(6))), w.id, w.approval_state, COALESCE(w.approval_request, ''), w.approval_ref,
              w.approval_target, w.approval_target_kind, 'legacy', COALESCE(w.approval_decided_at, w.updated_at),
              w.approval_escalated_at, w.approval_decided_by, w.approval_decided_at, NULL
       FROM ${source} w
       WHERE w.approval_state IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM work_item_approvals a WHERE a.work_item_id = w.id)`,
    )
    .run().changes;
}

/**
 * Register any department that holds Todos but is missing from the registry
 * (review F2). Department-changing writes now mint the row in their own
 * transaction; this reconciles rows written BEFORE that fix (move-only
 * departments). Idempotent — runs on every boot.
 */
export function reconcileDepartmentRegistry(db: DatabaseType): number {
  const missing = db
    .prepare(
      "SELECT DISTINCT department FROM work_items WHERE department IS NOT NULL AND department NOT IN (SELECT slug FROM departments) ORDER BY department",
    )
    .pluck()
    .all() as string[];
  if (missing.length === 0) return 0;
  const portal = fs.existsSync(CONFIG_PATH) ? loadConfig().portal : undefined;
  const companyPrefix = resolveTodoIdPrefix(portal?.companyName ?? "Tengu", portal?.companyPrefix);
  for (const slug of missing) {
    resolveDepartmentPrefix(db, slug, companyPrefix);
  }
  return missing.length;
}

const V1_REQUIRED_TABLE_SQL = new Map<string, string>([
  ["work_items", V1_WORK_ITEMS_TABLE_DDL],
  ["work_item_events", WORK_ITEM_EVENTS_TABLE_DDL],
  ["work_item_edit_receipts", WORK_ITEM_EDIT_RECEIPTS_DDL],
  ["work_item_id_allocator", V1_WORK_ITEM_ID_ALLOCATOR_TABLE_DDL],
  ["work_item_id_burns", V1_WORK_ITEM_ID_BURNS_TABLE_DDL],
  ["work_item_id_issuances", V1_WORK_ITEM_ID_ISSUANCES_TABLE_DDL],
]);

function tableExists(db: DatabaseType, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function tableCount(db: DatabaseType, name: string): number {
  if (!tableExists(db, name)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) FROM "${name}"`).pluck().get());
}

function hasNonNullSessionTodoRefs(db: DatabaseType): boolean {
  if (!tableExists(db, "sessions")) return false;
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "work_item_id")) return false;
  return !!db.prepare("SELECT 1 FROM sessions WHERE work_item_id IS NOT NULL LIMIT 1").get();
}

function refusal(): never {
  throw new Error(UNSUPPORTED_PRERELEASE_TODO_DATA);
}

function currentTableSql(db: DatabaseType, name: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string } | undefined)?.sql;
}

const PRERELEASE_WORK_ITEMS_TABLE_SQL = `
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department TEXT, assignee TEXT, priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank REAL, version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref TEXT, acceptance TEXT, verify_policy TEXT, rounds INTEGER NOT NULL DEFAULT 0, budget_usd REAL,
  approval_state TEXT CHECK (approval_state IN ('pending','approved','rejected')), approval_request TEXT, approval_ref TEXT,
  approval_target TEXT, approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT, approval_decided_by TEXT, approval_decided_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
)`;

function recognizedEmptyPrerelease(db: DatabaseType): boolean {
  if (tableCount(db, "work_items") !== 0 || tableCount(db, "work_item_events") !== 0
    || tableCount(db, "work_item_edit_receipts") !== 0 || tableCount(db, "workflow_todo_event_claims") !== 0
    || hasNonNullSessionTodoRefs(db)) return false;
  if (tableExists(db, "work_items")
    && sqlShape(currentTableSql(db, "work_items")) !== sqlShape(PRERELEASE_WORK_ITEMS_TABLE_SQL)) return false;
  return true;
}

function hasShadowApprovalColumns(db: DatabaseType): boolean {
  return sqlShape(currentTableSql(db, "work_items")) === sqlShape(V2_APPROVAL_WORK_ITEMS_TABLE_DDL);
}

/** D21: `work_items` is v2-family (has the sub-task tree's `root_id`, absent
 *  from both the v1 and prerelease shapes) but still lacks `phase` — healed by
 *  `ALTER TABLE ... ADD COLUMN phase` in `migrateWorkItemsSchema` before
 *  classification. A direct column check, not a whole-table shape match
 *  against `PRE_PHASE_WORK_ITEMS_TABLE_DDL`, so this composes with
 *  `shadowedApprovals`: a pre-PLA-48 database can lack BOTH the dropped
 *  approval columns' healing AND `phase` at once, and each defect heals
 *  independently. The `root_id` gate keeps this from firing on a v1 or
 *  prerelease table, which the ALTER/index DDL below would not apply to. */
function hasPrePhaseWorkItems(db: DatabaseType): boolean {
  if (!tableExists(db, "work_items")) return false;
  const columns = new Set((db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>).map((column) => column.name));
  return columns.has("root_id") && !columns.has("phase");
}

/** A v2 database whose only defects heal at boot: additive tables that shipped
 *  later are absent (e.g. slice-1 pre-comments), and/or work_items still carries
 *  the pre-PLA-48 approval columns or lacks the `phase` column. Never a refusal
 *  and never a rebuild. Every OTHER table that is present must shape-match exactly. */
function recognizedHealableV2(db: DatabaseType): boolean {
  const additiveNames = new Set(V2_ADDITIVE_TABLES.map((table) => table.name));
  const shadowedApprovals = hasShadowApprovalColumns(db);
  const prePhase = hasPrePhaseWorkItems(db);
  const missing = V2_ADDITIVE_TABLES.filter((table) => !tableExists(db, table.name));
  if (missing.length === 0 && !shadowedApprovals && !prePhase) return false; // nothing to heal
  for (const [name, expected] of REQUIRED_TABLE_SQL) {
    if (name === "work_items" && (shadowedApprovals || prePhase)) continue;
    if (additiveNames.has(name) && !tableExists(db, name)) continue;
    if (sqlShape(currentTableSql(db, name)) !== sqlShape(expected)) return false;
  }
  return true;
}

function recognizedV1(db: DatabaseType): boolean {
  for (const [name, expected] of V1_REQUIRED_TABLE_SQL) {
    if (sqlShape(currentTableSql(db, name)) !== sqlShape(expected)) return false;
  }
  return true;
}

function triggerSql(db: DatabaseType, name: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined)?.sql;
}

export function verifyCurrentWorkItemSchema(db: DatabaseType): void {
  for (const [name, expected] of REQUIRED_TABLE_SQL) {
    if (sqlShape(currentTableSql(db, name)) !== sqlShape(expected)) refusal();
  }
  for (const [name, expected] of REQUIRED_TRIGGER_SQL) {
    if (sqlShape(triggerSql(db, name)) !== sqlShape(expected)) refusal();
  }
  const allocator = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator").all() as Array<{
    prefix: string;
    high_water: number;
  }>;
  for (const row of allocator) {
    if (!TODO_ID_PREFIX_PATTERN.test(row.prefix) || !Number.isSafeInteger(row.high_water)) refusal();
    const burns = db.prepare("SELECT ordinal FROM work_item_id_burns WHERE prefix = ? ORDER BY ordinal")
      .pluck().all(row.prefix) as number[];
    if (burns.length !== row.high_water || burns.some((ordinal, index) => ordinal !== index + 1)) refusal();
  }
  const knownPrefixes = new Set(allocator.map((row) => row.prefix));
  const orphanBurn = db.prepare("SELECT 1 FROM work_item_id_burns WHERE prefix NOT IN (SELECT prefix FROM work_item_id_allocator) LIMIT 1").get();
  if (orphanBurn) refusal();
  const issuances = db.prepare("SELECT prefix, ordinal FROM work_item_id_issuances").all() as Array<{ prefix: string; ordinal: number }>;
  const issued = new Set(issuances.map((row) => `${row.prefix}-${row.ordinal}`));
  for (const row of issuances) {
    const water = allocator.find((a) => a.prefix === row.prefix)?.high_water ?? 0;
    if (row.ordinal < 1 || row.ordinal > water) refusal();
  }
  const items = db.prepare("SELECT id, parent_id, root_id, depth FROM work_items").all() as Array<{
    id: string;
    parent_id: string | null;
    root_id: string;
    depth: number;
  }>;
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (!isTodoId(item.id) || !knownPrefixes.has(todoIdPrefix(item.id)) || !issued.has(`${todoIdPrefix(item.id)}-${todoIdOrdinal(item.id)}`)) refusal();
    if (item.parent_id === null) {
      if (item.root_id !== item.id || item.depth !== 0) refusal();
    } else {
      const parent = byId.get(item.parent_id);
      if (!parent || item.depth !== parent.depth + 1 || item.root_id !== parent.root_id) refusal();
    }
  }
  for (const table of ["work_item_events", "sessions"] as const) {
    if (!tableExists(db, table)) continue;
    const column = table === "sessions" ? "work_item_id" : "work_item_id";
    const refs = db.prepare(`SELECT DISTINCT ${column} FROM ${table} WHERE ${column} IS NOT NULL`).pluck().all() as string[];
    if (refs.some((id) => !isTodoId(id) || !byId.has(id))) refusal();
  }
  const commentRows = db.prepare("SELECT id, work_item_id, parent_comment_id FROM work_item_comments").all() as Array<{
    id: string;
    work_item_id: string;
    parent_comment_id: string | null;
  }>;
  const commentById = new Map(commentRows.map((row) => [row.id, row]));
  for (const row of commentRows) {
    if (!byId.has(row.work_item_id)) refusal();
    if (row.parent_comment_id !== null) {
      // Threading is single-level: a parent must be a TOP-LEVEL comment on the
      // same work item (the write path re-parents replies-to-replies).
      const parent = commentById.get(row.parent_comment_id);
      if (!parent || parent.parent_comment_id !== null || parent.work_item_id !== row.work_item_id) refusal();
    }
  }
  const relationRows = db.prepare("SELECT src_id, dst_id, kind FROM work_item_relations").all() as Array<{
    src_id: string;
    dst_id: string;
    kind: string;
  }>;
  const blocksOut = new Map<string, string[]>();
  for (const row of relationRows) {
    if (!byId.has(row.src_id) || !byId.has(row.dst_id)) refusal();
    // `relates` is symmetric and stored ONCE in canonical order.
    if (row.kind === "relates" && !(row.src_id < row.dst_id)) refusal();
    if (row.kind === "blocks") {
      const targets = blocksOut.get(row.src_id) ?? [];
      targets.push(row.dst_id);
      blocksOut.set(row.src_id, targets);
    }
  }
  // The `blocks` graph must be a DAG (write-path invariant, re-proven at boot —
  // row counts are small). Iterative coloring DFS: 1 = on stack, 2 = done.
  const relationColor = new Map<string, 1 | 2>();
  for (const start of blocksOut.keys()) {
    if (relationColor.has(start)) continue;
    const stack: Array<{ node: string; nextIndex: number }> = [{ node: start, nextIndex: 0 }];
    relationColor.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = blocksOut.get(frame.node) ?? [];
      if (frame.nextIndex >= targets.length) {
        relationColor.set(frame.node, 2);
        stack.pop();
        continue;
      }
      const next = targets[frame.nextIndex++];
      const seen = relationColor.get(next);
      if (seen === 1) refusal();
      if (seen === undefined) {
        relationColor.set(next, 1);
        stack.push({ node: next, nextIndex: 0 });
      }
    }
  }
  const labelIds = new Set(db.prepare("SELECT id FROM labels").pluck().all() as string[]);
  const labelPairs = db.prepare("SELECT work_item_id, label_id FROM work_item_labels").all() as Array<{
    work_item_id: string;
    label_id: string;
  }>;
  for (const pair of labelPairs) {
    if (!byId.has(pair.work_item_id) || !labelIds.has(pair.label_id)) refusal();
  }
  // Approvals: every row references a live item, and at most one PENDING row per
  // item. The partial unique index makes the latter unforgeable through SQL, but
  // the data is re-proven here anyway (belt and suspenders, house style).
  const approvalRows = db.prepare("SELECT work_item_id, state FROM work_item_approvals").all() as Array<{
    work_item_id: string;
    state: string;
  }>;
  const pendingSeen = new Set<string>();
  for (const row of approvalRows) {
    if (!byId.has(row.work_item_id)) refusal();
    if (row.state === "pending") {
      if (pendingSeen.has(row.work_item_id)) refusal();
      pendingSeen.add(row.work_item_id);
    }
  }
  // Attachments: every row references a live item; a comment-scoped row's
  // comment must belong to the SAME item; bytes and the sha256 hex shape are
  // re-proven data-level. Deliberately NO file-existence check at boot — files
  // can be large/many, and content integrity is verified on every download.
  const attachmentRows = db.prepare("SELECT work_item_id, comment_id, bytes, sha256 FROM work_item_attachments").all() as Array<{
    work_item_id: string;
    comment_id: string | null;
    bytes: number;
    sha256: string;
  }>;
  for (const row of attachmentRows) {
    if (!byId.has(row.work_item_id)) refusal();
    if (!Number.isSafeInteger(row.bytes) || row.bytes <= 0) refusal();
    if (!/^[0-9a-f]{64}$/.test(row.sha256)) refusal();
    if (row.comment_id !== null) {
      const comment = commentById.get(row.comment_id);
      if (!comment || comment.work_item_id !== row.work_item_id) refusal();
    }
  }
  // Checkpoint verify commands: every row references a live item, and (design
  // invariant, docs/tengu/10-checkpointing.md) only a depth-3 sub-sub-task may
  // carry one — the write path enforces this, re-proven here at boot.
  const verifyRows = db.prepare("SELECT work_item_id, command FROM work_item_verify").all() as Array<{
    work_item_id: string;
    command: string;
  }>;
  for (const row of verifyRows) {
    const owner = byId.get(row.work_item_id);
    if (!owner || owner.depth !== 3) refusal();
    if (!row.command.trim()) refusal();
  }
  // Fan-out planning gate: every row references a live item. No depth
  // restriction (unlike verify) — parallelSafe is a planner call on any
  // sub-task, not sub-sub-task-only.
  const fanoutRows = db.prepare("SELECT work_item_id FROM work_item_fanout").pluck().all() as string[];
  for (const workItemId of fanoutRows) {
    if (!byId.has(workItemId)) refusal();
  }
  // Project identity: every row references a live item, and (design invariant,
  // docs/tengu/03-implementation-plan.md step 11) only a root (depth 0) item —
  // a project — may carry one. The write path enforces this; re-proven here.
  const workspaceRows = db.prepare("SELECT work_item_id, workspace_path FROM work_item_workspace").all() as Array<{
    work_item_id: string;
    workspace_path: string;
  }>;
  for (const row of workspaceRows) {
    const owner = byId.get(row.work_item_id);
    if (!owner || owner.depth !== 0) refusal();
    if (!row.workspace_path.trim()) refusal();
  }
  // Profile identity (D22): every overlay row references a live item, only a
  // root (depth 0) item may carry one — mirrors the workspace check above —
  // and its profile_id must reference a registered profile.
  const profileIds = new Set(db.prepare("SELECT id FROM profiles").pluck().all() as string[]);
  const profileRows = db.prepare("SELECT work_item_id, profile_id FROM work_item_profile").all() as Array<{
    work_item_id: string;
    profile_id: string;
  }>;
  for (const row of profileRows) {
    const owner = byId.get(row.work_item_id);
    if (!owner || owner.depth !== 0) refusal();
    if (!profileIds.has(row.profile_id)) refusal();
  }
  // Phase registry (D21): every row references a live root (depth 0) item —
  // a project — the same one-root-per-outcome convention the workspace and
  // profile overlays use.
  const phaseRows = db.prepare("SELECT root_id, slug FROM work_item_phases").all() as Array<{
    root_id: string;
    slug: string;
  }>;
  for (const row of phaseRows) {
    const owner = byId.get(row.root_id);
    if (!owner || owner.depth !== 0) refusal();
    if (!row.slug.trim()) refusal();
  }
}

function classifyOpenWorkItemsDatabase(db: DatabaseType): WorkItemSchemaPreflight {
  const todoTables = [
    "work_items", "work_item_events", "work_item_edit_receipts", "workflow_todo_event_claims",
    "work_item_id_allocator", "work_item_id_burns", "work_item_id_issuances",
  ].filter((name) => tableExists(db, name));
  if (!tableExists(db, "work_items")) {
    if (todoTables.some((name) => name.startsWith("work_item_id_"))) refusal();
    if (recognizedEmptyPrerelease(db)) return todoTables.length > 0 || tableExists(db, "sessions")
      ? "empty-prerelease"
      : "absent";
    return refusal();
  }
  try {
    verifyCurrentWorkItemSchema(db);
    return "current";
  } catch {
    // A v2 database missing additive tables (created before a later slice
    // shipped them) is "current": the migration creates them at boot.
    if (recognizedHealableV2(db)) return "current";
    if (recognizedV1(db)) return "v1";
    if (todoTables.some((name) => name.startsWith("work_item_id_"))) refusal();
    if (recognizedEmptyPrerelease(db)) return "empty-prerelease";
    return refusal();
  }
}

/** Read-only and side-effect free. It runs before WAL mode or any schema write. */
export function preflightWorkItemsDatabase(filename: string): WorkItemSchemaPreflight {
  if (!fs.existsSync(filename) || fs.statSync(filename).size === 0) return "absent";
  let db: DatabaseType;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true });
  } catch (err) {
    // The file exists and is non-empty but won't open read-only — that is a
    // corrupt/invalid database, not prerelease Todo data. Say so plainly.
    throw new Error(`${CORRUPT_SESSIONS_DATABASE}\n(underlying: ${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    return classifyOpenWorkItemsDatabase(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A malformed DB can also surface here (mid-read). Distinguish corruption
    // from a genuine prerelease-Todo refusal so the operator gets the right fix.
    if (isSqliteCorruption(message)) {
      throw new Error(`${CORRUPT_SESSIONS_DATABASE}\n(underlying: ${message})`);
    }
    throw err; // genuine UNSUPPORTED_PRERELEASE_TODO_DATA refusal or other — preserve it
  } finally {
    db.close();
  }
}

export interface WorkItemsMigrationResult { rebuilt: boolean; rows: number }

/** Create the clean v2 model, replace a previously classified empty prerelease
 *  shape, or rebuild a recognized v1 database in place (per-prefix allocator +
 *  tree columns, data preserved). */
export function migrateWorkItemsSchema(
  db: DatabaseType,
  _preflight: WorkItemSchemaPreflight = tableExists(db, "work_items") ? "current" : "absent",
): WorkItemsMigrationResult {
  registerWorkItemIdentityFunctions(db);
  const migrate = db.transaction((): WorkItemsMigrationResult => {
    // In-place self-heal, BEFORE classification: a v2 database created before a
    // later slice shipped its additive tables (or before PLA-48 dropped the
    // approval columns, or before D21 added `phase`) is brought to the
    // canonical shape here so the exact-shape verifier below sees the complete
    // v2 schema. IF NOT EXISTS makes this a no-op everywhere else, and a
    // refused classification rolls the creates back with the transaction.
    // Never a rebuild, never a refusal. (List order matters: work_item_labels
    // references labels; work_item_profile references profiles.)
    const shadowedApprovals = hasShadowApprovalColumns(db);
    const prePhase = hasPrePhaseWorkItems(db);
    if (shadowedApprovals || prePhase || sqlShape(currentTableSql(db, "work_items")) === sqlShape(WORK_ITEMS_TABLE_DDL)) {
      for (const table of V2_ADDITIVE_TABLES) db.exec(table.ddl);
      // PLA-48: a pre-drop database hands its shadowed approvals to their one
      // owner and then loses the columns — same transaction, both or neither.
      if (shadowedApprovals) {
        backfillWorkItemApprovals(db, "work_items");
        for (const column of V2_APPROVAL_COLUMNS) db.exec(`ALTER TABLE work_items DROP COLUMN ${column}`);
      }
      // D21: appended last so a fresh CREATE and this healed ALTER agree on
      // the stored shape byte-for-byte (see WORK_ITEMS_TABLE_DDL's comment).
      if (prePhase) {
        db.exec(`ALTER TABLE work_items ADD COLUMN phase TEXT`);
        db.exec(WORK_ITEMS_INDEX_DDL);
      }
      // Slice-5 review F2: departments that gained Todos through pre-fix
      // move-only writes get their registry rows.
      reconcileDepartmentRegistry(db);
    }
    // The read-only preflight necessarily precedes the write lock. Reclassify after
    // BEGIN IMMEDIATE so a concurrent winner's committed schema is never dropped.
    const liveShape = classifyOpenWorkItemsDatabase(db);
    if (liveShape === "empty-prerelease") {
      for (const name of ["workflow_todo_event_claims", "work_item_edit_receipts", "work_item_events", "work_items"]) {
        db.exec(`DROP TABLE IF EXISTS ${name}`);
      }
      if (tableExists(db, "meta")) {
        db.prepare("DELETE FROM meta WHERE key IN ('todo_status_event_claims_migrated','todo_status_replay_watermark')").run();
      }
    } else if (liveShape === "current") {
      return { rebuilt: false, rows: 0 };
    }
    if (liveShape === "v1") {
      const legacy = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator WHERE singleton = 1")
        .get() as { prefix: string | null; high_water: number } | undefined;
      // A recognized-v1 schema whose seeded singleton row is missing is data
      // corruption (v1 triggers forbid deleting it) — refuse with the curated
      // message rather than crashing on the read below.
      if (!legacy) throw new Error(CORRUPT_SESSIONS_DATABASE);
      const legacyBurns = db.prepare("SELECT ordinal, claim_digest, burned_at FROM work_item_id_burns ORDER BY ordinal")
        .all() as Array<{ ordinal: number; claim_digest: string; burned_at: string }>;
      const legacyIssuances = db.prepare("SELECT ordinal, issued_at FROM work_item_id_issuances ORDER BY ordinal")
        .all() as Array<{ ordinal: number; issued_at: string }>;

      // Identity tables: tiny — snapshot to JS, drop, recreate canonical, reinsert.
      // Dropping a table drops its triggers; row-level guard triggers do NOT fire on DROP.
      db.exec("DROP TABLE work_item_id_issuances");
      db.exec("DROP TABLE work_item_id_burns");
      db.exec("DROP TABLE work_item_id_allocator");
      db.exec(WORK_ITEM_IDENTITY_TABLES_DDL);
      if (legacy.prefix !== null) {
        db.prepare("INSERT INTO work_item_id_allocator (prefix, high_water) VALUES (?, ?)")
          .run(legacy.prefix, legacy.high_water);
        for (const burn of legacyBurns) {
          db.prepare("INSERT INTO work_item_id_burns (prefix, ordinal, claim_digest, burned_at) VALUES (?, ?, ?, ?)")
            .run(legacy.prefix, burn.ordinal, burn.claim_digest, burn.burned_at);
        }
        for (const issuance of legacyIssuances) {
          db.prepare("INSERT INTO work_item_id_issuances (prefix, ordinal, issued_at) VALUES (?, ?, ?)")
            .run(legacy.prefix, issuance.ordinal, issuance.issued_at);
        }
      }

      // work_items: rename-first so the new table's stored SQL is the canonical string.
      // The stale v1 triggers on work_items still reference the dropped singleton
      // allocator shape; ALTER TABLE RENAME re-parses them and would refuse, so drop
      // them first (they die with the legacy table anyway; v2 triggers are installed
      // and verified below).
      db.exec("DROP TRIGGER IF EXISTS work_items_claim_required");
      db.exec("DROP TRIGGER IF EXISTS work_items_mark_issued");
      db.exec("DROP TRIGGER IF EXISTS work_items_id_immutable");
      db.exec("ALTER TABLE work_items RENAME TO work_items_v1_legacy");
      db.exec(WORK_ITEMS_TABLE_DDL);
      for (const table of V2_ADDITIVE_TABLES) db.exec(table.ddl);
      db.exec(`INSERT INTO work_items (
          id, title, body, status, department, assignee,
          created_by, parent_id, root_id, depth, due_at,
          priority, rank, version, source, source_ref, acceptance, verify_policy, rounds, budget_usd,
          created_at, updated_at, closed_at)
        SELECT
          id, title, body, status, department, assignee,
          CASE WHEN source = 'human' THEN 'operator' ELSE 'system' END,
          NULL, id, 0, NULL,
          priority, rank, version, source, source_ref, acceptance, verify_policy, rounds, budget_usd,
          created_at, updated_at, closed_at
        FROM work_items_v1_legacy`);
      // Approvals come off the legacy row — read BEFORE the table is dropped.
      backfillWorkItemApprovals(db, "work_items_v1_legacy");
      reconcileDepartmentRegistry(db); // v1 rows carried departments with no registry
      const migratedRows = Number(db.prepare("SELECT COUNT(*) FROM work_items").pluck().get());
      db.exec("DROP TABLE work_items_v1_legacy");
      db.exec(WORK_ITEMS_INDEX_DDL);
      db.exec(WORK_ITEM_IDENTITY_TRIGGERS_DDL);
      verifyCurrentWorkItemSchema(db);
      return { rebuilt: true, rows: migratedRows };
    }
    db.exec(WORK_ITEM_IDENTITY_TABLES_DDL);
    db.exec(WORK_ITEMS_TABLE_DDL);
    db.exec(WORK_ITEMS_INDEX_DDL);
    db.exec(WORK_ITEM_EVENTS_DDL);
    for (const table of V2_ADDITIVE_TABLES) db.exec(table.ddl);
    db.exec(WORK_ITEM_EDIT_RECEIPTS_DDL);
    db.exec(WORK_ITEM_IDENTITY_TRIGGERS_DDL);
    verifyCurrentWorkItemSchema(db);
    return { rebuilt: liveShape === "empty-prerelease", rows: 0 };
  });
  return migrate.immediate();
}
