import { useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUp,
  Bell,
  ChevronRight,
  CornerDownRight,
  FileText,
  Image as ImageIcon,
  Link2,
  Paperclip,
  Pencil,
  Plus,
  Tags,
  X,
} from "lucide-react"
import {
  api,
  type Employee,
  type WorkItemAttachmentWire,
  type WorkItemCommentWire,
  type WorkItemDetailWire,
  type WorkItemEventWire,
} from "@/lib/api"
import { STATUS_LABEL, commentAuthorLabel, operatorSafeTodoError } from "@/lib/todos"
import { formatMessage } from "@/components/chat/message-markdown"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { buildCommentThread, type CommentThreadNode } from "../comment-thread"
import { displayNameOf, formatRelativeTime } from "../util"
import { AttachmentTile, useAttachmentPreview } from "./attachment-preview"
import { formatBytes } from "./attachments"

/* Todos v2 slice 6 — Activity: ONE merged feed (design-doc §7.2.11, mock
 * task-detail.html). Machine events are one-line whispers (12px glyph + actor
 * + verb + age); runs of ≥3 consecutive audit events collapse into
 * "▸ N quiet updates" (comments NEVER collapse — the feed stays centered on
 * voices). Comments wear the delegation grammar: attribution row (22px emoji
 * avatar + name + age) + rail-quoted body, one reply level, tombstones keep
 * shape, attachments as chips aligned to the rail indent. The desktop composer
 * sits in-flow before the feed and GROWS into a card when attachments are
 * pending (chips row above the input, floating ×). This IS the bounce/audit
 * history — expanding every fold reaches the full log. */

const FOLD_THRESHOLD = 3
const HTML_COMMENT_LINE = /^\s*<!--(?:(?!-->).)*-->\s*$/

/** Comment voices render themselves; their audit shadows would double them. */
const FEED_HIDDEN_KINDS = new Set(["comment_added", "comment_edited", "comment_deleted", "none"])

type FeedItem =
  | { kind: "comment"; at: string; node: CommentThreadNode }
  | { kind: "event"; at: string; event: WorkItemEventWire }

type FeedBlock =
  | { kind: "comment"; node: CommentThreadNode }
  | { kind: "event"; event: WorkItemEventWire }
  | { kind: "fold"; events: WorkItemEventWire[] }

export function buildFeed(events: WorkItemEventWire[], comments: WorkItemCommentWire[]): FeedBlock[] {
  const items: FeedItem[] = [
    ...events
      .filter((event) => !FEED_HIDDEN_KINDS.has(event.kind))
      .map((event): FeedItem => ({ kind: "event", at: event.createdAt, event })),
    ...buildCommentThread(comments).map((node): FeedItem => ({ kind: "comment", at: node.comment.createdAt, node })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  const blocks: FeedBlock[] = []
  let run: WorkItemEventWire[] = []
  const flushRun = () => {
    if (run.length >= FOLD_THRESHOLD) blocks.push({ kind: "fold", events: run })
    else for (const event of run) blocks.push({ kind: "event", event })
    run = []
  }
  for (const item of items) {
    if (item.kind === "event") {
      // The birth whisper stays visible — the mock never folds "created".
      if (item.event.kind === "created") {
        flushRun()
        blocks.push({ kind: "event", event: item.event })
      } else {
        run.push(item.event)
      }
    } else {
      flushRun()
      blocks.push({ kind: "comment", node: item.node })
    }
  }
  flushRun()
  return blocks
}

export function stripCommentMarkers(body: string): string {
  let inCodeBlock = false
  return body.split("\n").filter((line) => {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock
      return true
    }
    return inCodeBlock || !HTML_COMMENT_LINE.test(line)
  }).join("\n")
}

function actorLabel(actor: string | null, byName: Map<string, Employee>): string {
  if (!actor || actor === "system") return "The gateway"
  if (actor === "operator") return "You"
  if (actor.startsWith("session:")) return "A session"
  return displayNameOf(actor, byName)
}

interface Whisper {
  Icon: typeof Pencil
  text: string
  tinted?: boolean
}

export function whisperOf(event: WorkItemEventWire): Whisper {
  const detail = event.detail ?? {}
  switch (event.kind) {
    case "created":
      return { Icon: Plus, text: "created this todo" }
    case "child_created":
      return { Icon: Plus, text: `added a sub-task${typeof detail.childId === "string" ? ` ${detail.childId}` : ""}` }
    case "status_change": {
      if (detail.bounce === true) {
        return { Icon: CornerDownRight, text: `sent it back · round ${typeof detail.rounds === "number" ? detail.rounds : "?"}` }
      }
      const to = event.toStatus ? STATUS_LABEL[event.toStatus] : "?"
      return { Icon: ChevronRight, text: `moved it to ${to}` }
    }
    case "escalated":
      return {
        Icon: CornerDownRight,
        text: detail.reason === "max-rounds-exhausted" ? "escalated it — review rounds exhausted" : "escalated it",
        tinted: true,
      }
    case "note":
      if (typeof detail.assignee === "string") return { Icon: Pencil, text: `assigned ${detail.assignee}` }
      if (detail.approvalEscalated === true) return { Icon: Bell, text: "escalated the approval" }
      return { Icon: Pencil, text: "added a note" }
    case "metadata_edited":
      return { Icon: Pencil, text: "edited the details" }
    case "approval_requested":
      return { Icon: Bell, text: "asked for approval" }
    case "approval_decided":
      return { Icon: Bell, text: detail.decision === "approve" ? "approved it" : "sent the approval back" }
    case "attachment_added":
      return { Icon: Paperclip, text: `attached ${typeof detail.filename === "string" ? detail.filename : "a file"}` }
    case "attachment_removed":
      return { Icon: Paperclip, text: "removed an attachment" }
    case "label_changed":
      return { Icon: Tags, text: "changed the labels" }
    case "relation_added":
      return { Icon: Link2, text: "linked a related todo" }
    case "relation_removed":
      return { Icon: Link2, text: "removed a relation" }
    case "session_linked":
      return { Icon: Link2, text: "linked a session" }
    default:
      return { Icon: Pencil, text: event.kind.replace(/_/g, " ") }
  }
}

function WhisperLine({ event, byName }: { event: WorkItemEventWire; byName: Map<string, Employee> }) {
  const whisper = whisperOf(event)
  return (
    <div className="flex items-center gap-2 py-[7px] text-[12.5px] text-[var(--text-tertiary)]" data-testid={`whisper-${event.id}`}>
      <span className="mr-1.5 grid w-4 flex-none place-items-center text-[var(--text-quaternary)]">
        <whisper.Icon size={12} strokeWidth={2} aria-hidden />
      </span>
      <span className="min-w-0 truncate">
        <span className={`font-semibold ${whisper.tinted ? "text-[var(--system-red)]" : "text-[var(--text-secondary)]"}`}>
          {actorLabel(event.actor, byName)}
        </span>{" "}
        {whisper.text}
      </span>
      <span className="flex-none text-[var(--text-quaternary)]">· {formatRelativeTime(event.createdAt)}</span>
    </div>
  )
}

function avatarFor(comment: WorkItemCommentWire): string {
  return comment.authorKind === "operator" ? "operator" : comment.author
}

function commentAuthor(comment: WorkItemCommentWire, byName: Map<string, Employee>): string {
  if (comment.authorKind === "operator") return "You"
  if (comment.authorKind === "employee" && !comment.author.startsWith("session:")) {
    return displayNameOf(comment.author, byName)
  }
  return commentAuthorLabel(comment.author, comment.authorKind)
}

function AttachmentChips({ attachments, workItemId }: { attachments: WorkItemAttachmentWire[]; workItemId: string }) {
  const preview = useAttachmentPreview()
  if (attachments.length === 0) return null
  return (
    <div className="ml-[42px] mt-[9px] flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        preview.canPreview(attachment) ? (
          <AttachmentTile
            key={attachment.id}
            attachment={attachment}
            preview={preview}
            meta={formatBytes(attachment.bytes)}
            dense
            testId={`comment-attachment-${attachment.id}`}
          />
        ) : (
          <a
            key={attachment.id}
            href={api.workItemAttachmentUrl(workItemId, attachment.id)}
            download={attachment.filename}
            data-testid={`comment-attachment-${attachment.id}`}
            className="focus-ring flex h-10 items-center gap-2 rounded-[10px] bg-[var(--fill-tertiary)] pl-2 pr-3 text-[12.5px] font-medium text-[var(--text-primary)] shadow-[var(--shadow-ambient)] outline-none"
          >
            <span className="grid size-6 place-items-center rounded-[7px] bg-[var(--fill-secondary)] text-[var(--text-tertiary)]">
              <FileText size={12} strokeWidth={1.8} aria-hidden />
            </span>
            {attachment.filename}
            <span className="text-[11px] font-normal text-[var(--text-quaternary)]">{formatBytes(attachment.bytes)}</span>
          </a>
        ),
      )}
      {preview.lightbox}
    </div>
  )
}

function CommentBlock({
  comment,
  byName,
  attachments,
  workItemId,
  reply,
  onReply,
  onEdit,
  onDelete,
  busy,
}: {
  comment: WorkItemCommentWire
  byName: Map<string, Employee>
  attachments: WorkItemAttachmentWire[]
  workItemId: string
  reply?: boolean
  onReply?: () => void
  /** Operator-authored comments edit in place (gateway-enforced authority). */
  onEdit?: (body: string) => void
  /** The operator's surface deletes anything; tombstones keep shape. */
  onDelete?: () => void
  busy?: boolean
}) {
  const tombstoned = comment.deletedAt !== null
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  return (
    <div className={`pb-1 pt-3 ${reply ? "ml-[30px]" : ""}`} data-testid={`activity-comment-${comment.id}`}>
      <div className="flex items-center gap-2">
        {comment.authorKind === "operator" ? (
          <span className="grid size-[22px] flex-none place-items-center rounded-full bg-[var(--fill-secondary)] text-[12px]">🌈</span>
        ) : (
          <EmployeeAvatar name={avatarFor(comment)} size={22} fontSize={12} className="bg-[var(--fill-secondary)]" />
        )}
        <span className="text-[13px] font-semibold text-[var(--text-secondary)]">{commentAuthor(comment, byName)}</span>
        <span className="text-[11px] text-[var(--text-quaternary)]">{formatRelativeTime(comment.createdAt)}</span>
        {comment.editedAt && !tombstoned && <span className="text-[11px] text-[var(--text-quaternary)]">(edited)</span>}
      </div>
      {editing ? (
        <div className="ml-[42px] mt-[7px]">
          <textarea
            autoFocus
            data-testid={`activity-edit-${comment.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className="w-full min-w-0 resize-y rounded-[10px] bg-[var(--fill-quaternary)] p-2.5 text-[14.5px] text-[var(--text-primary)] outline-none"
          />
          <div className="mt-1 flex gap-3.5 text-[12px] font-medium text-[var(--text-quaternary)]">
            <button
              type="button"
              data-testid={`activity-edit-save-${comment.id}`}
              disabled={busy || !draft.trim()}
              onClick={() => {
                setEditing(false)
                if (draft.trim() && draft !== comment.body) onEdit?.(draft)
              }}
              className="focus-ring rounded outline-none hover:text-[var(--text-secondary)] disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="focus-ring rounded outline-none hover:text-[var(--text-secondary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className={`relative ml-[30px] mt-[7px] py-0.5 pl-3 text-[15px] leading-[1.55] ${
          tombstoned ? "" : "break-words text-[var(--text-secondary)]"
        }`}>
          <span aria-hidden className="absolute bottom-[3px] left-0 top-[3px] w-[2px] rounded-[1px] bg-[var(--fill-primary)]" />
          {tombstoned
            ? <span className="italic text-[var(--text-quaternary)]">[deleted]</span>
            : formatMessage(stripCommentMarkers(comment.body))}
        </div>
      )}
      <AttachmentChips attachments={attachments} workItemId={workItemId} />
      {!tombstoned && !editing && (
        <div className="ml-[42px] mt-1.5 flex gap-3.5 text-[12px] font-medium text-[var(--text-quaternary)]">
          {onReply && (
            <button type="button" data-testid={`activity-reply-${comment.id}`} onClick={onReply} className="focus-ring rounded outline-none hover:text-[var(--text-secondary)]">
              Reply
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              data-testid={`activity-edit-start-${comment.id}`}
              disabled={busy}
              onClick={() => {
                setDraft(comment.body)
                setEditing(true)
              }}
              className="focus-ring rounded outline-none hover:text-[var(--text-secondary)] disabled:opacity-50"
            >
              Edit
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              data-testid={`activity-delete-${comment.id}`}
              disabled={busy}
              onClick={onDelete}
              className="focus-ring rounded outline-none hover:text-[var(--text-secondary)] disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Pending composer files (local UI until send attaches them). */
interface PendingFile {
  key: string
  file: File
}

export function ActivitySection({
  detail,
  byName,
  mobile,
  announce,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  mobile: boolean
  announce: (message: string) => void
}) {
  const qc = useQueryClient()
  const id = detail.workItem.id
  const tail = detail.comments
  const commentsQuery = useQuery({
    queryKey: ["work-item-comments", id],
    queryFn: () => api.listWorkItemComments(id, { limit: 500 }),
    initialData: tail && tail.comments.length >= tail.total ? tail : undefined,
    staleTime: 10_000,
  })
  const attachmentsQuery = useQuery({
    queryKey: ["work-item-attachments", id],
    queryFn: async () => (await api.listWorkItemAttachments(id)).attachments,
    staleTime: 10_000,
  })
  const attachmentsByComment = useMemo(() => {
    const map = new Map<string, WorkItemAttachmentWire[]>()
    for (const attachment of attachmentsQuery.data ?? []) {
      if (!attachment.commentId) continue
      const list = map.get(attachment.commentId) ?? []
      list.push(attachment)
      map.set(attachment.commentId, list)
    }
    return map
  }, [attachmentsQuery.data])

  const blocks = useMemo(
    () => buildFeed(detail.events, commentsQuery.data?.comments ?? []).reverse(),
    [detail.events, commentsQuery.data],
  )

  const [openFolds, setOpenFolds] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState("")
  const [replyTo, setReplyTo] = useState<WorkItemCommentWire | null>(null)
  const [pending, setPending] = useState<PendingFile[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["work-item-comments", id] })
    void qc.invalidateQueries({ queryKey: ["work-item-attachments", id] })
    void qc.invalidateQueries({ queryKey: ["work-item", id] })
    void qc.invalidateQueries({ queryKey: ["work-items"] })
  }

  const send = useMutation({
    mutationFn: async ({ body, parentCommentId, files }: { body: string; parentCommentId?: string; files: File[] }) => {
      const { comment } = await api.addWorkItemComment(id, body, parentCommentId)
      for (const file of files) {
        await api.uploadWorkItemAttachment(id, file, comment.id)
      }
      return comment
    },
    onSuccess: () => {
      setDraft("")
      setReplyTo(null)
      setPending([])
    },
    onError: (error) => announce(operatorSafeTodoError(error, "Couldn't post the comment")),
    onSettled: invalidate,
  })

  // Comment edit/delete carried over from the retired sheet (stage-B review
  // disposition b): edit only what the operator authored, delete anything —
  // the gateway enforces the same authority server-side.
  const editComment = useMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) =>
      api.editWorkItemComment(id, commentId, body),
    onError: (error) => announce(operatorSafeTodoError(error, "Couldn't save the comment")),
    onSettled: invalidate,
  })
  const removeComment = useMutation({
    mutationFn: (commentId: string) => api.deleteWorkItemComment(id, commentId),
    onError: (error) => announce(operatorSafeTodoError(error, "Couldn't delete the comment")),
    onSettled: invalidate,
  })
  const commentBusy = editComment.isPending || removeComment.isPending
  const commentActions = (comment: WorkItemCommentWire) => ({
    onEdit:
      comment.authorKind === "operator"
        ? (body: string) => editComment.mutate({ commentId: comment.id, body })
        : undefined,
    onDelete: () => removeComment.mutate(comment.id),
    busy: commentBusy,
  })

  const submit = () => {
    const body = draft.trim()
    if (!body || send.isPending) return
    send.mutate({ body, parentCommentId: replyTo?.id, files: pending.map((p) => p.file) })
  }
  const stageFiles = (files: File[]) => {
    setPending((current) => [
      ...current,
      ...files.map((file) => ({ key: `${file.name}-${file.size}-${crypto.randomUUID()}`, file })),
    ])
  }

  const pendingChips = pending.length > 0 && (
    <div className="flex flex-wrap gap-2" data-testid="composer-pending">
      {pending.map((entry) => (
        <span
          key={entry.key}
          className="relative flex h-10 items-center gap-2 rounded-[10px] bg-[var(--fill-secondary)] pl-2 pr-3 text-[12.5px] font-medium text-[var(--text-primary)] shadow-[var(--shadow-ambient)]"
        >
          <span className="grid size-6 place-items-center rounded-[7px] bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]">
            {entry.file.type.startsWith("image/") ? <ImageIcon size={12} aria-hidden /> : <FileText size={12} aria-hidden />}
          </span>
          <span className="max-w-40 truncate">{entry.file.name}</span>
          <button
            type="button"
            aria-label={`Remove ${entry.file.name}`}
            onClick={() => setPending((current) => current.filter((candidate) => candidate.key !== entry.key))}
            className="absolute -right-1.5 -top-1.5 grid size-[18px] place-items-center rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] shadow-[var(--shadow-subtle)]"
          >
            <X size={10} strokeWidth={2.4} aria-hidden />
          </button>
        </span>
      ))}
    </div>
  )

  const replyRow = replyTo && (
    <div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]">
      Replying to {commentAuthor(replyTo, byName)}
      <button
        type="button"
        onClick={() => setReplyTo(null)}
        className="focus-ring rounded-full px-1.5 font-semibold text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-tertiary)]"
      >
        Cancel
      </button>
    </div>
  )

  const inputProps = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    },
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      const files = [...e.clipboardData.files]
      if (files.length > 0) {
        e.preventDefault()
        stageFiles(files)
      }
    },
    "aria-label": replyTo ? "Reply" : "Add a comment",
    "data-testid": "composer-input",
  }

  const composerCore = (
    <div className={pending.length > 0 ? "rounded-[18px] bg-[var(--fill-tertiary)] p-[10px_12px]" : ""}>
      {pendingChips && <div className="mb-[9px]">{pendingChips}</div>}
      {replyRow}
      <div className="flex items-center gap-2">
        <input
          {...inputProps}
          placeholder={replyTo ? "Reply…" : "Add a comment…"}
          className={`min-w-0 flex-1 text-[14.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] ${
            pending.length > 0 ? "bg-transparent px-1.5 py-1.5" : "rounded-[18px] bg-[var(--fill-tertiary)] px-4 py-2.5"
          }`}
        />
        <button
          type="button"
          aria-label="Attach"
          data-testid="composer-attach"
          onClick={() => fileRef.current?.click()}
          className="focus-ring grid size-8 flex-none place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-secondary)]"
        >
          <Paperclip size={15} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Send"
          data-testid="composer-send"
          disabled={send.isPending || !draft.trim()}
          onClick={submit}
          className="focus-ring grid size-[34px] flex-none place-items-center rounded-full outline-none disabled:opacity-40"
          style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
        >
          <ArrowUp size={15} strokeWidth={2.2} aria-hidden />
        </button>
      </div>
    </div>
  )

  /* The §8 fixed bottom bar IS the mobile composer (mock task-detail.html
   * .m-composer): paperclip · "+ Comment" capsule · accent send, material
   * blur, safe-area padded. It owns the bottom edge — the tab bar yields on
   * the pushed task page. Pending chips stack above the input row. */
  const mobileBar = (
    <div
      data-testid="task-composer-mobile"
      className="fixed inset-x-0 bottom-0 z-20 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-2.5 backdrop-blur-[20px]"
      style={{ background: "var(--material-thick)" }}
    >
      {pendingChips && <div className="mb-2.5">{pendingChips}</div>}
      {replyRow}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Attach"
          data-testid="composer-attach"
          onClick={() => fileRef.current?.click()}
          className="focus-ring grid size-[38px] flex-none place-items-center rounded-[12px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-secondary)]"
        >
          <Paperclip size={16} strokeWidth={2} aria-hidden />
        </button>
        <label className="flex min-h-[42px] min-w-0 flex-1 items-center gap-2 rounded-[21px] bg-[var(--fill-tertiary)] px-4">
          <Plus size={13} strokeWidth={2.2} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
          <input
            {...inputProps}
            placeholder={replyTo ? "Reply…" : "Comment"}
            className="min-w-0 flex-1 bg-transparent text-[14.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
        </label>
        <button
          type="button"
          aria-label="Send"
          data-testid="composer-send"
          disabled={send.isPending || !draft.trim()}
          onClick={submit}
          className="focus-ring grid size-[38px] flex-none place-items-center rounded-[19px] outline-none disabled:opacity-40"
          style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
        >
          <ArrowUp size={15} strokeWidth={2.2} aria-hidden />
        </button>
      </div>
    </div>
  )

  return (
    <div data-testid="task-activity">
      <div
        aria-hidden
        className="mt-10 h-px opacity-60"
        style={{ background: "linear-gradient(90deg, var(--separator), transparent)" }}
      />
      <div className="mb-1.5 mt-8 text-[17px] font-bold tracking-[-0.24px] text-[var(--text-primary)]">Activity</div>

      {!mobile && (
        <div className="mb-4" data-testid="task-composer">
          {composerCore}
        </div>
      )}

      <div>
        {blocks.map((block) => {
          if (block.kind === "comment") {
            return (
              <div key={`comment-${block.node.comment.id}`}>
                <CommentBlock
                  comment={block.node.comment}
                  byName={byName}
                  attachments={attachmentsByComment.get(block.node.comment.id) ?? []}
                  workItemId={id}
                  onReply={() => setReplyTo(block.node.comment)}
                  {...commentActions(block.node.comment)}
                />
                {block.node.replies.map((replyComment) => (
                  <CommentBlock
                    key={replyComment.id}
                    comment={replyComment}
                    byName={byName}
                    attachments={attachmentsByComment.get(replyComment.id) ?? []}
                    workItemId={id}
                    reply
                    {...commentActions(replyComment)}
                  />
                ))}
              </div>
            )
          }
          if (block.kind === "event") return <WhisperLine key={`event-${block.event.id}`} event={block.event} byName={byName} />
          const foldId = block.events[0].id
          const open = openFolds.has(foldId)
          return (
            <div key={`fold-${foldId}`}>
              <button
                type="button"
                data-testid={`activity-fold-${foldId}`}
                aria-expanded={open}
                onClick={() =>
                  setOpenFolds((current) => {
                    const next = new Set(current)
                    if (next.has(foldId)) next.delete(foldId)
                    else next.add(foldId)
                    return next
                  })
                }
                className="focus-ring flex items-center py-1.5 text-[12.5px] font-medium text-[var(--text-quaternary)] outline-none hover:text-[var(--text-secondary)]"
              >
                <ChevronRight
                  size={11}
                  strokeWidth={2.2}
                  aria-hidden
                  className={`ml-0.5 mr-[16.5px] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                />
                {block.events.length} quiet updates
              </button>
              {open && block.events.slice().reverse().map((event) => <WhisperLine key={event.id} event={event} byName={byName} />)}
            </div>
          )
        })}
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden
        data-testid="composer-file-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ""
          if (files.length > 0) stageFiles(files)
        }}
      />

      {/* Mobile: the fixed bottom bar (material blur, safe-area) is THE composer (§8). */}
      {mobile && mobileBar}
    </div>
  )
}
