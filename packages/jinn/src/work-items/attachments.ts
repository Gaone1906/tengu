import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { initDb } from '../sessions/registry.js';
import { ATTACHMENTS_DIR } from '../shared/paths.js';
import { parseTodoId } from './id.js';
import { appendWorkItemEvent } from './store.js';

/**
 * Work-item attachments — content-addressed files on Todos and comments
 * (Todos v2 slice 5). Bytes live at `<instance>/attachments/<sha[0:2]>/<sha>`;
 * the DB row carries the original filename, mime, and the RELATIVE storage
 * path. Agents CONSUME attachments by reading the absolute `storagePath` the
 * read surface returns — the gateway and its agents share a filesystem by
 * architecture (local-first), so nothing streams over MCP.
 *
 * Semantics (design decisions, locked):
 * - Content-addressed: identical content dedupes to ONE file. Removing a row
 *   never deletes the file while another row references the same hash
 *   (refcount by query, not by column); the LAST removal unlinks it.
 * - `comment_id` NULL = attached to the Todo; set = attached to that comment,
 *   which must belong to the same item and be live (not tombstoned) at attach
 *   time. Tombstoning a comment later does NOT delete its attachment rows.
 * - Authority: any identified caller attaches to an item or to their OWN
 *   comment (pair-matched on author + authorKind, operator overrides);
 *   removal is uploader-or-operator.
 * - Caps: 25 MB per file, 200 MB per item (sum of its rows' bytes, comment
 *   rows included — dedup does not discount the budget).
 * - `attachment_added` bumps the Todo version (new material resorts lists);
 *   `attachment_removed` is audit-only.
 */

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_ITEM_MAX_BYTES = 200 * 1024 * 1024;

export interface WorkItemAttachment {
  id: string; // wia_<12hex>
  workItemId: string;
  commentId: string | null;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  /** Absolute on-disk path — agents Read this directly. The DB stores the
   *  relative form (spec §3.2). */
  storagePath: string;
  uploadedBy: string;
  createdAt: string;
}

/** Who is uploading/removing: the comments identity model — the author string
 *  ('operator' | employee slug | `session:<uuid>`) plus its kind, so a slug
 *  colliding with a sentinel can never claim another principal's comments
 *  (the org boundary also reserves those names — belt and suspenders). */
export interface AttachmentActor {
  author: string;
  authorKind: 'operator' | 'employee' | 'system';
  operator: boolean;
}

export interface AddAttachmentInput {
  workItemId: string;
  /** NULL/absent = attached to the Todo itself; set = attached to that comment. */
  commentId?: string | null;
  filename: string;
  /** Falls back to application/octet-stream — mime sniffing from the original
   *  filename is the upload boundary's job (route/MCP), not the store's. */
  mime?: string;
  /** Staged temp file the store CONSUMES: renamed into the content-addressed
   *  location, or deleted when the content already exists (dedup). */
  stagedPath: string;
  uploader: AttachmentActor;
}

export type WorkItemAttachmentErrorCode =
  | 'attachment-not-found'
  | 'attachment-forbidden'
  | 'attachment-too-large'
  | 'attachment-item-budget'
  | 'comment-not-found'
  | 'comment-deleted';

export class WorkItemAttachmentError extends Error {
  readonly code: WorkItemAttachmentErrorCode;

  constructor(code: WorkItemAttachmentErrorCode, message: string) {
    super(message);
    this.name = 'WorkItemAttachmentError';
    this.code = code;
  }
}

export function attachmentsDir(): string {
  return ATTACHMENTS_DIR;
}

/** Absolute content-addressed path for a stored hash. */
export function attachmentPath(sha256: string): string {
  return path.join(ATTACHMENTS_DIR, sha256.slice(0, 2), sha256);
}

/** Write a buffer to the staging area (same filesystem as the store, so the
 *  content-addressed move is an atomic rename). Upload boundaries stage here
 *  before calling addAttachment. */
export function stageAttachmentBuffer(buffer: Buffer): string {
  const dir = path.join(ATTACHMENTS_DIR, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `stage-${randomUUID()}`);
  fs.writeFileSync(staged, buffer);
  return staged;
}

function rowToAttachment(row: Record<string, unknown>): WorkItemAttachment {
  return {
    id: row.id as string,
    workItemId: row.work_item_id as string,
    commentId: (row.comment_id as string) ?? null,
    filename: row.filename as string,
    mime: row.mime as string,
    bytes: row.bytes as number,
    sha256: row.sha256 as string,
    storagePath: path.join(ATTACHMENTS_DIR, row.storage_path as string),
    uploadedBy: row.uploaded_by as string,
    createdAt: row.created_at as string,
  };
}

export function getAttachment(id: string): WorkItemAttachment | undefined {
  const row = initDb().prepare('SELECT * FROM work_item_attachments WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAttachment(row) : undefined;
}

/** All of a Todo's attachment rows — item-level and per-comment — oldest first. */
export function listAttachments(workItemId: string): WorkItemAttachment[] {
  const id = parseTodoId(workItemId);
  return (
    initDb()
      .prepare('SELECT * FROM work_item_attachments WHERE work_item_id = ? ORDER BY created_at, rowid')
      .all(id) as Record<string, unknown>[]
  ).map(rowToAttachment);
}

/** Sum of every attachment row's bytes on the item — comment rows included,
 *  dedup NOT discounted (the budget is per row, decision 1). */
export function itemBytesUsed(workItemId: string): number {
  const id = parseTodoId(workItemId);
  return Number(
    initDb().prepare('SELECT COALESCE(SUM(bytes), 0) FROM work_item_attachments WHERE work_item_id = ?').pluck().get(id),
  );
}

function fsyncBestEffort(target: string): void {
  try {
    const fd = fs.openSync(target, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Durability belt only — a failed fsync must not fail the upload.
  }
}

/** Move staged content into the content-addressed location: hash → rename into
 *  `<sha[0:2]>/<sha>` (or drop the staged copy when the content already
 *  exists), fsync'd best-effort. Returns the hash and size. */
function storeStagedContent(stagedPath: string): { sha256: string; bytes: number } {
  const digest = createHash('sha256');
  const fd = fs.openSync(stagedPath, 'r');
  let bytes = 0;
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      digest.update(chunk.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  const sha256 = digest.digest('hex');
  const destination = attachmentPath(sha256);
  if (fs.existsSync(destination)) {
    fs.unlinkSync(stagedPath); // dedup — the content is already stored
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fsyncBestEffort(stagedPath);
    fs.renameSync(stagedPath, destination);
    fsyncBestEffort(path.dirname(destination));
  }
  return { sha256, bytes };
}

/** Attach a staged file to a Todo (or to one of its live comments). The staged
 *  file is consumed on success AND on refusal (nothing is left behind). */
export function addAttachment(input: AddAttachmentInput): WorkItemAttachment {
  const db = initDb();
  const workItemId = parseTodoId(input.workItemId);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input.stagedPath);
  } catch {
    throw new WorkItemAttachmentError('attachment-not-found', `staged upload file not found: ${input.stagedPath}`);
  }
  const discardStaged = (): void => {
    try {
      fs.unlinkSync(input.stagedPath);
    } catch {
      /* already consumed */
    }
  };
  if (stat.size <= 0) {
    discardStaged();
    throw new WorkItemAttachmentError('attachment-too-large', 'attachment must not be empty');
  }
  if (stat.size > ATTACHMENT_MAX_BYTES) {
    discardStaged();
    throw new WorkItemAttachmentError(
      'attachment-too-large',
      `attachment is ${stat.size} bytes — the per-file cap is 25 MB (${ATTACHMENT_MAX_BYTES} bytes)`,
    );
  }

  // Validate the target under the write lock BEFORE touching the content store,
  // so a refusal leaves no orphaned file behind.
  const now = new Date().toISOString();
  const filename = input.filename.trim() || 'attachment';
  const mime = input.mime?.trim() || 'application/octet-stream';
  const validate = db.transaction((): void => {
    const itemExists = db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(workItemId);
    if (!itemExists) throw new Error(`Todo ${workItemId} not found`);
    if (input.commentId) {
      const comment = db
        .prepare('SELECT work_item_id, author, author_kind, deleted_at FROM work_item_comments WHERE id = ?')
        .get(input.commentId) as
        | { work_item_id: string; author: string; author_kind: string; deleted_at: string | null }
        | undefined;
      if (!comment) {
        throw new WorkItemAttachmentError('comment-not-found', `comment ${input.commentId} not found`);
      }
      if (comment.work_item_id !== workItemId) {
        throw new WorkItemAttachmentError(
          'comment-not-found',
          `comment ${input.commentId} belongs to a different Todo (${comment.work_item_id})`,
        );
      }
      if (comment.deleted_at !== null) {
        throw new WorkItemAttachmentError(
          'comment-deleted',
          `comment ${input.commentId} was deleted — attachments can only be added to a live comment`,
        );
      }
      // Author identity is (author, authorKind) as a PAIR — same rationale as
      // comment edit authority: a sentinel-colliding slug must never qualify.
      const own =
        input.uploader.author === comment.author && input.uploader.authorKind === comment.author_kind;
      if (!input.uploader.operator && !own) {
        throw new WorkItemAttachmentError(
          'attachment-forbidden',
          `only the comment author (or the operator) may attach files to comment ${input.commentId}`,
        );
      }
    }
    const used = Number(
      db.prepare('SELECT COALESCE(SUM(bytes), 0) FROM work_item_attachments WHERE work_item_id = ?').pluck().get(workItemId),
    );
    if (used + stat.size > ATTACHMENT_ITEM_MAX_BYTES) {
      throw new WorkItemAttachmentError(
        'attachment-item-budget',
        `Todo ${workItemId} already carries ${used} attachment bytes — adding ${stat.size} would exceed the 200 MB per-item cap (${ATTACHMENT_ITEM_MAX_BYTES} bytes)`,
      );
    }
  });
  try {
    validate();
  } catch (err) {
    discardStaged();
    throw err;
  }

  // Content first, row second: a crash between the two leaves an inert orphaned
  // file (no GC by design), never a row pointing at missing bytes.
  const { sha256, bytes } = storeStagedContent(input.stagedPath);
  const attachment: WorkItemAttachment = {
    id: `wia_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    workItemId,
    commentId: input.commentId ?? null,
    filename,
    mime,
    bytes,
    sha256,
    storagePath: attachmentPath(sha256),
    uploadedBy: input.uploader.author,
    createdAt: now,
  };
  const txn = db.transaction((): WorkItemAttachment => {
    // The caps + comment target were validated above, but re-run under THIS
    // write transaction — the content move happened outside any lock.
    validate();
    db.prepare(
      `INSERT INTO work_item_attachments (id, work_item_id, comment_id, filename, mime, bytes, sha256, storage_path, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attachment.id,
      attachment.workItemId,
      attachment.commentId,
      attachment.filename,
      attachment.mime,
      attachment.bytes,
      attachment.sha256,
      `${sha256.slice(0, 2)}/${sha256}`,
      attachment.uploadedBy,
      attachment.createdAt,
    );
    appendWorkItemEvent({
      workItemId,
      kind: 'attachment_added',
      actor: input.uploader.author,
      detail: {
        attachmentId: attachment.id,
        filename: attachment.filename,
        bytes: attachment.bytes,
        sha256: attachment.sha256,
        ...(attachment.commentId ? { commentId: attachment.commentId } : {}),
      },
      versionEffect: 'state', // new material resorts activity-ordered lists
    });
    return attachment;
  });
  return txn();
}

/** Remove an attachment row (uploader or operator). The stored file is
 *  unlinked only when no other row references the same content hash. Returns
 *  false for an unknown id. */
export function removeAttachment(id: string, remover: AttachmentActor): boolean {
  const db = initDb();
  const result = db.transaction((): { removed: boolean; unlink?: string } => {
    const row = db.prepare('SELECT * FROM work_item_attachments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return { removed: false };
    const attachment = rowToAttachment(row);
    // uploaded_by stores the author string only; the org boundary reserves the
    // operator/system/session:* namespaces, so string equality cannot be
    // spoofed by an employee slug.
    if (!remover.operator && remover.author !== attachment.uploadedBy) {
      throw new WorkItemAttachmentError(
        'attachment-forbidden',
        `only the uploader (or the operator) may remove attachment ${id}`,
      );
    }
    db.prepare('DELETE FROM work_item_attachments WHERE id = ?').run(id);
    appendWorkItemEvent({
      workItemId: attachment.workItemId,
      kind: 'attachment_removed',
      actor: remover.operator ? 'operator' : remover.author,
      detail: { attachmentId: id, filename: attachment.filename, sha256: attachment.sha256 },
      versionEffect: 'audit',
    });
    const others = db
      .prepare('SELECT COUNT(*) FROM work_item_attachments WHERE sha256 = ?')
      .pluck()
      .get(attachment.sha256) as number;
    return { removed: true, ...(others === 0 ? { unlink: attachment.storagePath } : {}) };
  })();
  if (result.unlink) {
    try {
      fs.unlinkSync(result.unlink);
    } catch {
      // Best-effort — a leftover content file is inert (no row references it).
    }
  }
  return result.removed;
}
