import { randomUUID } from 'node:crypto';
import { initDb } from '../sessions/registry.js';
import { parseTodoId } from './id.js';
import { appendWorkItemEvent } from './store.js';

/**
 * Work-item comments — the mutable human/agent discussion layer of the Todos
 * ledger (Todos v2 slice 2). `work_item_events` stays pure machine audit; every
 * comment mutation here records its audit event in the same transaction.
 *
 * Semantics (design decisions, locked):
 * - Threading is single-level: a comment is top-level or replies to a TOP-LEVEL
 *   comment. Replying to a reply re-parents to the thread root (Slack model).
 * - Delete = tombstone: body is cleared and `deleted_at` stamped; the row and
 *   the thread shape survive. Tombstones cannot be edited; replying to one is
 *   fine.
 * - Authority: anyone identified may comment; edit/tombstone is author-only,
 *   plus the operator surface for any comment.
 * - `comment_added` bumps the Todo version (activity resorts lists);
 *   `comment_edited`/`comment_deleted` are audit-only.
 */

export interface WorkItemComment {
  id: string; // wic_<12hex>
  workItemId: string;
  parentCommentId: string | null;
  authorKind: 'operator' | 'employee' | 'system';
  author: string;
  /** '' when tombstoned. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface AddCommentInput {
  workItemId: string;
  body: string;
  author: string;
  authorKind: WorkItemComment['authorKind'];
  parentCommentId?: string | null;
}

/** Who is attempting an edit/tombstone: the derived author identity (string AND
 *  kind — the kind discriminates the operator/system sentinel namespace from
 *  employee slugs, so a slug literally named "operator" never matches the
 *  operator's comments), plus whether the call comes from the authenticated
 *  operator surface. */
export interface CommentEditor {
  author: string;
  authorKind: WorkItemComment['authorKind'];
  operator: boolean;
}

export type WorkItemCommentErrorCode = 'comment-not-found' | 'comment-forbidden' | 'comment-deleted';

export class WorkItemCommentError extends Error {
  readonly code: WorkItemCommentErrorCode;

  constructor(code: WorkItemCommentErrorCode, message: string) {
    super(message);
    this.name = 'WorkItemCommentError';
    this.code = code;
  }
}

/** Comments returned per page: default when the caller passes no limit, and the
 *  hard per-page ceiling. */
export const COMMENT_PAGE_DEFAULT_LIMIT = 50;
export const COMMENT_PAGE_MAX_LIMIT = 500;
/** Comments included in the Todo detail payload's tail. */
export const COMMENT_TAIL_DEFAULT = 10;

function rowToComment(row: Record<string, unknown>): WorkItemComment {
  return {
    id: row.id as string,
    workItemId: row.work_item_id as string,
    parentCommentId: (row.parent_comment_id as string) ?? null,
    authorKind: row.author_kind as WorkItemComment['authorKind'],
    author: row.author as string,
    body: row.body as string,
    createdAt: row.created_at as string,
    editedAt: (row.edited_at as string) ?? null,
    deletedAt: (row.deleted_at as string) ?? null,
  };
}

function getCommentRow(db: ReturnType<typeof initDb>, id: string): WorkItemComment | undefined {
  const row = db.prepare('SELECT * FROM work_item_comments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToComment(row) : undefined;
}

export function getComment(id: string): WorkItemComment | undefined {
  return getCommentRow(initDb(), id);
}

/** Add a comment (or single-level reply). A reply to a reply is re-parented to
 *  the thread root at write time. Throws on an unknown Todo, an unknown or
 *  cross-item parent, or a blank body; a tombstoned parent is fine (the thread
 *  shape survives deletion). */
export function addComment(input: AddCommentInput): WorkItemComment {
  const db = initDb();
  const workItemId = parseTodoId(input.workItemId);
  if (!input.body || !input.body.trim()) {
    throw new Error('comment body must not be empty');
  }
  const now = new Date().toISOString();
  const comment: WorkItemComment = {
    id: `wic_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    workItemId,
    parentCommentId: null,
    authorKind: input.authorKind,
    author: input.author,
    body: input.body,
    createdAt: now,
    editedAt: null,
    deletedAt: null,
  };
  const txn = db.transaction((): WorkItemComment => {
    const itemExists = db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(workItemId);
    if (!itemExists) throw new Error(`Todo ${workItemId} not found`);
    if (input.parentCommentId) {
      const parent = getCommentRow(db, input.parentCommentId);
      if (!parent) throw new WorkItemCommentError('comment-not-found', `parent comment ${input.parentCommentId} not found`);
      if (parent.workItemId !== workItemId) {
        throw new WorkItemCommentError('comment-not-found', `parent comment ${parent.id} belongs to a different Todo (${parent.workItemId})`);
      }
      comment.parentCommentId = parent.parentCommentId ?? parent.id;
    }
    db.prepare(
      `INSERT INTO work_item_comments (id, work_item_id, parent_comment_id, author_kind, author, body, created_at, edited_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(comment.id, comment.workItemId, comment.parentCommentId, comment.authorKind, comment.author, comment.body, comment.createdAt);
    appendWorkItemEvent({
      workItemId,
      kind: 'comment_added',
      actor: input.author,
      detail: { commentId: comment.id },
      versionEffect: 'state', // new discussion resorts activity-ordered lists
    });
    return comment;
  });
  return txn();
}

function requireEditable(db: ReturnType<typeof initDb>, id: string, editor: CommentEditor, action: string): WorkItemComment {
  const comment = getCommentRow(db, id);
  if (!comment) throw new WorkItemCommentError('comment-not-found', `comment ${id} not found`);
  // Author identity is (author, authorKind) as a PAIR — the string alone would
  // let an employee slug that collides with a sentinel ("operator"/"system")
  // claim another principal's comments.
  if (!editor.operator && (editor.author !== comment.author || editor.authorKind !== comment.authorKind)) {
    throw new WorkItemCommentError('comment-forbidden', `only the comment author (or the operator) may ${action} it`);
  }
  return comment;
}

/** Edit a comment's body. Author-or-operator; tombstones cannot be edited. */
export function editComment(id: string, body: string, editor: CommentEditor): WorkItemComment {
  const db = initDb();
  if (!body || !body.trim()) throw new Error('comment body must not be empty');
  const txn = db.transaction((): WorkItemComment => {
    const comment = requireEditable(db, id, editor, 'edit');
    if (comment.deletedAt) {
      throw new WorkItemCommentError('comment-deleted', `comment ${id} was deleted and cannot be edited`);
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE work_item_comments SET body = ?, edited_at = ? WHERE id = ?').run(body, now, id);
    appendWorkItemEvent({
      workItemId: comment.workItemId,
      kind: 'comment_edited',
      actor: editor.operator ? 'operator' : editor.author,
      detail: { commentId: id },
      versionEffect: 'audit', // wordsmithing never churns the Todo version
    });
    return { ...comment, body, editedAt: now };
  });
  return txn();
}

/** Tombstone a comment: body cleared, `deleted_at` stamped, row and thread shape
 *  retained. Author-or-operator. Idempotent — deleting a tombstone is a no-op. */
export function tombstoneComment(id: string, editor: CommentEditor): WorkItemComment {
  const db = initDb();
  const txn = db.transaction((): WorkItemComment => {
    const comment = requireEditable(db, id, editor, 'delete');
    if (comment.deletedAt) return comment;
    const now = new Date().toISOString();
    db.prepare("UPDATE work_item_comments SET body = '', deleted_at = ? WHERE id = ?").run(now, id);
    appendWorkItemEvent({
      workItemId: comment.workItemId,
      kind: 'comment_deleted',
      actor: editor.operator ? 'operator' : editor.author,
      detail: { commentId: id },
      versionEffect: 'audit',
    });
    return { ...comment, body: '', deletedAt: now };
  });
  return txn();
}

export interface CommentPage {
  comments: WorkItemComment[];
  /** Exact per-item comment count, before LIMIT/OFFSET. */
  total: number;
}

/** List a Todo's comments chronologically (oldest first) with LIMIT/OFFSET
 *  paging. An unknown Todo simply reads as empty — existence 404s belong to the
 *  route layer. */
export function listComments(workItemId: string, opts?: { limit?: number; offset?: number }): CommentPage {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const limit = Math.min(
    COMMENT_PAGE_MAX_LIMIT,
    typeof opts?.limit === 'number' && Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : COMMENT_PAGE_DEFAULT_LIMIT,
  );
  const offset = typeof opts?.offset === 'number' && Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
  const rows = db
    .prepare('SELECT * FROM work_item_comments WHERE work_item_id = ? ORDER BY created_at, rowid LIMIT ? OFFSET ?')
    .all(id, limit, offset) as Record<string, unknown>[];
  const total = Number(db.prepare('SELECT COUNT(*) FROM work_item_comments WHERE work_item_id = ?').pluck().get(id));
  return { comments: rows.map(rowToComment), total };
}

/** The last `n` comments (default 10) in chronological order, with the exact
 *  total — the capped tail the Todo detail payload embeds. */
export function commentsTail(workItemId: string, n = COMMENT_TAIL_DEFAULT): CommentPage {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const limit = Math.min(COMMENT_PAGE_MAX_LIMIT, Math.max(0, Math.floor(n)));
  const rows = db
    .prepare('SELECT * FROM work_item_comments WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(id, limit) as Record<string, unknown>[];
  const total = Number(db.prepare('SELECT COUNT(*) FROM work_item_comments WHERE work_item_id = ?').pluck().get(id));
  return { comments: rows.map(rowToComment).reverse(), total };
}
