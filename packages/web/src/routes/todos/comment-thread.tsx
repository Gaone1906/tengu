import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type Employee, type WorkItemCommentPageWire, type WorkItemCommentWire } from "@/lib/api"
import { commentAuthorLabel, operatorSafeTodoError } from "@/lib/todos"
import { displayNameOf, formatRelativeTime } from "./util"

/* Todos v2 slice 2 — the comment thread on the Todo detail sheet. Chronological,
 * single-level reply indent (the gateway re-parents deeper replies to the thread
 * root), composer at the bottom. No optimistic updates: every mutation refetches
 * through the query cache. Tombstoned comments render as [deleted] and keep the
 * thread shape. */

export interface CommentThreadNode {
  comment: WorkItemCommentWire
  replies: WorkItemCommentWire[]
}

/** Group a chronological comment list into top-level nodes with their replies.
 *  A reply whose parent falls outside the loaded page renders as top-level
 *  rather than disappearing. */
export function buildCommentThread(comments: WorkItemCommentWire[]): CommentThreadNode[] {
  const nodes = new Map<string, CommentThreadNode>()
  const roots: CommentThreadNode[] = []
  for (const comment of comments) {
    if (comment.parentCommentId) continue
    const node: CommentThreadNode = { comment, replies: [] }
    nodes.set(comment.id, node)
    roots.push(node)
  }
  for (const comment of comments) {
    if (!comment.parentCommentId) continue
    const parent = nodes.get(comment.parentCommentId)
    if (parent) parent.replies.push(comment)
    else roots.push({ comment: { ...comment, parentCommentId: null }, replies: [] })
  }
  return roots
}

function authorLabel(comment: WorkItemCommentWire, byName: Map<string, Employee>): string {
  if (comment.authorKind === "employee" && !comment.author.startsWith("session:")) {
    return displayNameOf(comment.author, byName)
  }
  return commentAuthorLabel(comment.author, comment.authorKind)
}

function CommentItem({
  comment,
  byName,
  indent,
  onReply,
  onEdit,
  onDelete,
  busy,
}: {
  comment: WorkItemCommentWire
  byName: Map<string, Employee>
  indent: boolean
  onReply?: () => void
  onEdit?: (body: string) => void
  onDelete?: () => void
  busy: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const tombstoned = comment.deletedAt !== null
  const actionClass = "min-h-8 rounded-full px-2 text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
  return (
    <div data-testid={`comment-${comment.id}`} className={`min-w-0 ${indent ? "ml-6" : ""}`}>
      <div className="rounded-[10px] bg-[var(--fill-quaternary)] p-[9px_12px]">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[length:var(--text-caption1)]">
          <span className="font-semibold text-[var(--text-primary)]">{authorLabel(comment, byName)}</span>
          <span className="text-[var(--text-tertiary)]">{formatRelativeTime(comment.createdAt)}</span>
          {comment.editedAt && !tombstoned && <span className="text-[var(--text-quaternary)]">(edited)</span>}
        </div>
        {editing ? (
          <div className="mt-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              className="w-full min-w-0 resize-y rounded-[8px] border-0 bg-[var(--bg-secondary)] p-2 text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none"
            />
            <div className="mt-1 flex gap-1.5">
              <button
                type="button"
                disabled={busy || !draft.trim()}
                onClick={() => {
                  setEditing(false)
                  if (draft.trim() && draft !== comment.body) onEdit?.(draft)
                }}
                className={actionClass}
              >
                Save
              </button>
              <button type="button" onClick={() => { setEditing(false); setDraft(comment.body) }} className={actionClass}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className={`mt-0.5 whitespace-pre-wrap break-words text-[length:var(--text-subheadline)] leading-snug ${tombstoned ? "italic text-[var(--text-quaternary)]" : "text-[var(--text-primary)]"}`}>
            {tombstoned ? "[deleted]" : comment.body}
          </div>
        )}
      </div>
      {!tombstoned && !editing && (
        <div className="mt-0.5 flex gap-0.5">
          {onReply && (
            <button type="button" disabled={busy} onClick={onReply} className={actionClass}>
              Reply
            </button>
          )}
          {onEdit && (
            <button type="button" disabled={busy} onClick={() => { setDraft(comment.body); setEditing(true) }} className={actionClass}>
              Edit
            </button>
          )}
          {onDelete && (
            <button type="button" disabled={busy} onClick={onDelete} className={actionClass}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function CommentThread({
  workItemId,
  tail,
  byName,
}: {
  workItemId: string
  /** The detail payload's last-10 tail — the count badge's fallback and, when
   *  it already holds the whole thread, the initial render. */
  tail?: WorkItemCommentPageWire
  byName: Map<string, Employee>
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState("")
  const [replyTo, setReplyTo] = useState<WorkItemCommentWire | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: ["work-item-comments", workItemId],
    queryFn: () => api.listWorkItemComments(workItemId, { limit: 500 }),
    initialData: tail && tail.comments.length >= tail.total ? tail : undefined,
    staleTime: 10_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["work-item-comments", workItemId] })
    void queryClient.invalidateQueries({ queryKey: ["work-item", workItemId] })
    void queryClient.invalidateQueries({ queryKey: ["work-items"] })
  }
  const failWith = (fallback: string) => (cause: unknown) => setError(operatorSafeTodoError(cause, fallback))

  const add = useMutation({
    mutationFn: ({ body, parentCommentId }: { body: string; parentCommentId?: string }) =>
      api.addWorkItemComment(workItemId, body, parentCommentId),
    onSuccess: () => {
      setDraft("")
      setReplyTo(null)
      setError(null)
    },
    onError: failWith("Couldn't post the comment"),
    onSettled: invalidate,
  })
  const edit = useMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) =>
      api.editWorkItemComment(workItemId, commentId, body),
    onSuccess: () => setError(null),
    onError: failWith("Couldn't save the comment"),
    onSettled: invalidate,
  })
  const remove = useMutation({
    mutationFn: (commentId: string) => api.deleteWorkItemComment(workItemId, commentId),
    onSuccess: () => setError(null),
    onError: failWith("Couldn't delete the comment"),
    onSettled: invalidate,
  })
  const busy = add.isPending || edit.isPending || remove.isPending

  const total = data?.total ?? tail?.total ?? 0
  const thread = buildCommentThread(data?.comments ?? [])

  const submit = () => {
    const body = draft.trim()
    if (!body || add.isPending) return
    add.mutate(replyTo ? { body, parentCommentId: replyTo.id } : { body })
  }

  const itemActions = (comment: WorkItemCommentWire, topLevel: boolean) => ({
    onReply: topLevel ? () => setReplyTo(comment) : undefined,
    // The web surface is the operator's: edit only what the operator authored,
    // delete anything (the gateway enforces the same authority server-side).
    onEdit: comment.authorKind === "operator"
      ? (body: string) => edit.mutate({ commentId: comment.id, body })
      : undefined,
    onDelete: () => remove.mutate(comment.id),
  })

  return (
    <div className="mt-5" data-testid="comment-thread">
      <div className="mb-2.5 flex items-center gap-1.5 text-[length:var(--text-caption2)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
        Comments
        <span
          data-testid="comment-count"
          className="rounded-full bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[11px] font-bold normal-case tracking-normal text-[var(--text-secondary)]"
        >
          {total}
        </span>
      </div>
      {error && (
        <div role="alert" className="mb-2 break-words rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-[8px_12px] text-[length:var(--text-footnote)] text-[var(--system-red)]">
          {error}
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-2">
        {thread.map((node) => (
          <div key={node.comment.id} className="flex min-w-0 flex-col gap-1.5">
            <CommentItem
              comment={node.comment}
              byName={byName}
              indent={false}
              busy={busy}
              {...itemActions(node.comment, true)}
            />
            {node.replies.length > 0 && (
              <div data-testid={`comment-replies-${node.comment.id}`} className="flex min-w-0 flex-col gap-1.5">
                {node.replies.map((reply) => (
                  <CommentItem
                    key={reply.id}
                    comment={reply}
                    byName={byName}
                    indent
                    busy={busy}
                    {...itemActions(reply, false)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2.5">
        {replyTo && (
          <div className="mb-1 flex items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            Replying to {authorLabel(replyTo, byName)}
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              className="min-h-8 rounded-full px-2 font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-tertiary)]"
            >
              Cancel
            </button>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={replyTo ? "Reply…" : "Add a comment…"}
          rows={2}
          className="w-full min-w-0 resize-y rounded-[10px] border-0 bg-[var(--fill-quaternary)] p-[9px_12px] text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
        />
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={submit}
            className="min-h-9 rounded-full bg-[var(--accent-fill)] px-3.5 text-[length:var(--text-footnote)] font-semibold text-[var(--accent)] transition-opacity disabled:opacity-50"
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  )
}
