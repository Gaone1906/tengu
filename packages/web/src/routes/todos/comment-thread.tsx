import type { WorkItemCommentWire } from "@/lib/api"

/* Todos v2 slice 2 → slice 6 — the pure comment-thread builder. The sheet-era
 * CommentThread component retired with the detail sheet at the stage-C
 * cutover; the Activity feed (task-page/activity.tsx) is the one comment
 * renderer and consumes this builder unchanged. Chronological, single-level
 * reply indent (the gateway re-parents deeper replies to the thread root);
 * tombstoned comments keep the thread shape. */

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
