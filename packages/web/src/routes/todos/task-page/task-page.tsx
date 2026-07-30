import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import {
  api,
  ApiError,
  type WorkItemAttachmentWire,
  type WorkItemDetailWire,
  type WorkItemRelationKindWire,
  type WorkItemRelationWire,
  type WorkItemStatusWire,
  type WorkItemTreeNodeWire,
} from "@/lib/api"
import { operatorSafeTodoError } from "@/lib/todos"
import { isTodoId, todoPath } from "@/lib/todo-id"
import { useDepartments } from "@/hooks/use-departments"
import { PageLayout } from "@/components/page-layout"
import { useTheme } from "@/routes/providers"
import {
  useDecideApproval,
  useEmployeesByName,
  useOrg,
  useSetWorkItemStatus,
  useTodoById,
} from "../use-todos"
import { parseBoardParam, boardPath, boardKey } from "../board/board-route"
import { departmentTitle } from "../board/board-switcher"
import { CrumbBar, type CrumbAncestor } from "./crumb-bar"
import { TaskBanner } from "./banner"
import { PropsRail } from "./props-rail"
import { ChipCluster } from "./chip-cluster"
import { useTaskPickers } from "./use-task-pickers"
import { BodyEditor } from "./body-editor"
import { AcceptanceChecklist, parseAcceptance } from "./acceptance"
import { SubTasksSection } from "./subtasks"
import { RelationsSection } from "./relations"
import { AttachmentsSection } from "./attachments"
import { ActivitySection } from "./activity"

/* Variant A keeps the Todo's live conversation on the page and folds its
 * document sections behind one Details row. Core working properties stay in
 * the header; the full editor and less-frequent properties remain one tap
 * away. The URL is still the Todo, and back restores the board's scroll. */

const MOBILE_QUERY = "(max-width: 700px)"

function wordCount(text: string | null): number {
  return text?.trim() ? text.trim().split(/\s+/).length : 0
}
function useIsTaskMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false),
  )
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return mobile
}

/** Walk the root tree to the item: the crumb bar's ancestor trail. */
export function ancestorsOf(root: WorkItemTreeNodeWire | undefined, id: string): CrumbAncestor[] {
  if (!root) return []
  const path: CrumbAncestor[] = []
  const walk = (node: WorkItemTreeNodeWire, trail: CrumbAncestor[]): CrumbAncestor[] | null => {
    if (node.id === id) return trail
    for (const child of node.children ?? []) {
      const found = walk(child, [...trail, { id: node.id, title: node.title }])
      if (found) return found
    }
    return null
  }
  return walk(root, path) ?? []
}

/** Find the item's own node inside the root tree (sub-tasks, roll-ups). */
export function nodeOf(root: WorkItemTreeNodeWire | undefined, id: string): WorkItemTreeNodeWire | undefined {
  if (!root) return undefined
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const found = nodeOf(child, id)
    if (found) return found
  }
  return undefined
}

interface TaskRouteState {
  fromBoard?: string
  focusBannerReason?: boolean
}

const LIVE_SESSION_STATES = new Set(["running", "waiting"])

function workingElapsed(detail: WorkItemDetailWire): string | null {
  if (detail.workItem.status !== "executing") return null
  let startedAt: string | undefined
  for (let i = detail.events.length - 1; i >= 0; i--) {
    if (detail.events[i].toStatus === "executing") {
      startedAt = detail.events[i].createdAt
      break
    }
  }
  const start = Date.parse(startedAt ?? detail.workItem.updatedAt)
  if (Number.isNaN(start)) return null
  const mins = Math.max(0, Math.round((Date.now() - start) / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

export default function TaskPage() {
  const { todoId } = useParams()
  const id = isTodoId(todoId) ? todoId : null
  const navigate = useNavigate()
  const location = useLocation()
  const routeState = (location.state ?? {}) as TaskRouteState
  const mobile = useIsTaskMobile()
  const { theme } = useTheme()
  const isDark = useMemo(() => {
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme")
      if (attr) return attr !== "light"
    }
    return theme !== "light"
  }, [theme])

  const detailQuery = useTodoById(id)
  const detail = detailQuery.data ?? undefined
  const item = detail?.workItem
  const rootId = item?.rootId ?? id ?? ""
  const treeQuery = useQuery({
    queryKey: ["work-item-tree", rootId],
    queryFn: () => api.getWorkItemTree(rootId),
    enabled: !!item && !!rootId,
    staleTime: 10_000,
  })
  const rootNode = treeQuery.data?.tree.root
  const ancestors = useMemo(() => (id ? ancestorsOf(rootNode, id) : []), [rootNode, id])

  const org = useOrg()
  const byName = useEmployeesByName(org.data?.employees)
  const departments = useDepartments()

  const { data: sessions } = useQuery({
    queryKey: ["work-item-sessions", id ?? ""],
    queryFn: () => api.listWorkItemSessions(id!),
    enabled: !!id,
    staleTime: 10_000,
  })
  const hasLiveSession = (sessions ?? []).some((s) => LIVE_SESSION_STATES.has(s.status ?? ""))

  // ── Transient refusal callout — always the gateway's words ────────────────
  const [callout, setCallout] = useState<string | null>(null)
  const calloutTimer = useRef<number | null>(null)
  const announce = useCallback((message: string) => {
    setCallout(message)
    if (calloutTimer.current !== null) window.clearTimeout(calloutTimer.current)
    calloutTimer.current = window.setTimeout(() => setCallout(null), 6000)
  }, [])
  useEffect(() => () => {
    if (calloutTimer.current !== null) window.clearTimeout(calloutTimer.current)
  }, [])

  const setStatus = useSetWorkItemStatus()
  const decide = useDecideApproval()

  // ── Pickers (one open at a time; §7.3) ────────────────────────────────────
  const itemNode = useMemo(() => (id ? nodeOf(rootNode, id) : undefined), [rootNode, id])
  const openChildren = useMemo(
    () => (itemNode?.children ?? []).filter((child) => child.status !== "done" && child.status !== "cancelled").length,
    [itemNode],
  )
  const pickers = useTaskPickers({
    detail,
    employees: org.data?.employees ?? [],
    departments: departments.data ?? [],
    openChildren,
    mobile,
    announce,
  })

  // ── Section mutations (sub-tasks, relations, attachments) ────────────────
  const qc = useQueryClient()
  const invalidateTree = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["work-item-tree"] })
    void qc.invalidateQueries({ queryKey: ["work-items"] })
    if (id) void qc.invalidateQueries({ queryKey: ["work-item", id] })
  }, [qc, id])
  const failWith = useCallback(
    (fallback: string) => (error: unknown) =>
      announce(operatorSafeTodoError(error, error instanceof ApiError ? error.message : fallback)),
    [announce],
  )
  const childStatus = useMutation({
    mutationFn: ({ childId, status }: { childId: string; status: WorkItemStatusWire }) =>
      api.setWorkItemStatus(childId, status),
    onError: failWith("The gateway refused the move"),
    onSettled: invalidateTree,
  })
  const childAssign = useMutation({
    mutationFn: ({ childId, assignee }: { childId: string; assignee: string }) => api.assignWorkItem(childId, assignee),
    onError: failWith("Couldn't assign the sub-task"),
    onSettled: invalidateTree,
  })
  const addSubTask = useMutation({
    mutationFn: (title: string) => api.createWorkItem({ title, parentId: id! }),
    onError: failWith("Failed to add the sub-task"),
    onSettled: invalidateTree,
  })
  const addRelation = useMutation({
    mutationFn: ({ srcId, kind, dstId }: { srcId: string; kind: WorkItemRelationKindWire; dstId: string }) =>
      api.addWorkItemRelation(srcId, kind, dstId),
    onError: failWith("Couldn't add the relation"),
    onSettled: invalidateTree,
  })
  const removeRelation = useMutation({
    mutationFn: (relation: WorkItemRelationWire) =>
      relation.direction === "in"
        ? api.removeWorkItemRelation(relation.other.id, relation.kind, id!)
        : api.removeWorkItemRelation(id!, relation.kind, relation.other.id),
    onError: failWith("Couldn't remove the relation"),
    onSettled: invalidateTree,
  })
  const uploadAttachments = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await api.uploadWorkItemAttachment(id!, file)
    },
    onError: failWith("Couldn't attach the file"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-item-attachments", id] })
      if (id) void qc.invalidateQueries({ queryKey: ["work-item", id] })
    },
  })
  const removeAttachment = useMutation({
    mutationFn: (attachment: WorkItemAttachmentWire) => api.deleteWorkItemAttachment(id!, attachment.id),
    onError: failWith("Couldn't remove the attachment"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-item-attachments", id] })
      if (id) void qc.invalidateQueries({ queryKey: ["work-item", id] })
    },
  })
  const attachmentsQuery = useQuery({
    queryKey: ["work-item-attachments", id],
    queryFn: async () => (await api.listWorkItemAttachments(id!)).attachments,
    enabled: !!id && !!item,
    staleTime: 10_000,
  })

  const commitBannerReason = useCallback(
    (note: string) => {
      if (!item) return
      setStatus.mutate(
        { id: item.id, status: item.status, note },
        {
          onError: (error) =>
            announce(operatorSafeTodoError(error, error instanceof ApiError ? error.message : "Couldn't save the reason")),
        },
      )
    },
    [item, setStatus, announce],
  )
  const runDecision = useCallback(
    (decision: "approve" | "reject", note?: string, choice?: string) => {
      if (!item) return
      decide.mutate(
        { id: item.id, decision, note, choice },
        {
          onError: (error) => announce(operatorSafeTodoError(error, "Couldn't record the decision")),
        },
      )
    },
    [item, decide, announce],
  )

  // ── Board context (the crumb's back affordance) ───────────────────────────
  const boardKeyRaw = routeState.fromBoard ?? item?.department ?? "my"
  const board = parseBoardParam(boardKeyRaw)
  const boardLabel =
    board.kind === "my" ? "My requests"
    : board.kind === "attention" ? "Attention"
    : board.kind === "everything" ? "Everything"
    : departmentTitle(board.slug)
  const goBack = useCallback(() => {
    // Arriving from a board leaves it one POP away — going back that way
    // restores the board's cached scroll position. Otherwise push its path.
    if (routeState.fromBoard && window.history.length > 1) navigate(-1)
    else navigate(boardPath(board))
  }, [routeState.fromBoard, navigate, board])

  const openTodo = useCallback(
    (nextId: string) => navigate(todoPath(nextId), { state: { fromBoard: boardKey(board) } }),
    [navigate, board],
  )

  const working = detail ? workingElapsed(detail) : null
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailSummary = useMemo(() => {
    if (!item) return ""
    const acceptance = parseAcceptance(item.acceptance)
    const checked = acceptance.filter((line) => line.checked).length
    const subTasks = itemNode?.children?.length ?? 0
    const attachments = (attachmentsQuery.data ?? []).filter((attachment) => attachment.commentId === null).length
    const bodyWords = wordCount(item.body)
    return [
      acceptance.length > 0 ? `Acceptance ${checked}/${acceptance.length}` : null,
      `${subTasks} sub-task${subTasks === 1 ? "" : "s"}`,
      `${attachments} attachment${attachments === 1 ? "" : "s"}`,
      `body ${bodyWords} word${bodyWords === 1 ? "" : "s"}`,
    ].filter(Boolean).join(" · ")
  }, [item, itemNode, attachmentsQuery.data])

  // ── Not found / loading ───────────────────────────────────────────────────
  if (!id) {
    return (
      <PageLayout>
        <TaskEmpty message="That's not a Todo ID." onBack={() => navigate("/todos")} />
      </PageLayout>
    )
  }
  if (detailQuery.isSuccess && detailQuery.data === null) {
    return (
      <PageLayout>
        <TaskEmpty message={`${id} doesn't exist (anymore).`} onBack={() => navigate("/todos")} />
      </PageLayout>
    )
  }
  // A transport/server failure is retryable — never masquerade as deletion
  // (only a canonical 404 means missing; useTodoById maps that to null).
  if (detailQuery.isError) {
    return (
      <PageLayout>
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="task-load-error">
          <div className="text-[20px] font-bold tracking-[-0.41px] text-[var(--text-primary)]">
            Couldn&rsquo;t load {id}.
          </div>
          <p className="max-w-[340px] text-[14px] leading-[1.5] text-[var(--text-tertiary)]">
            {operatorSafeTodoError(detailQuery.error, "The gateway didn't answer. It may be restarting.")}
          </p>
          <button
            type="button"
            data-testid="task-load-retry"
            onClick={() => void detailQuery.refetch()}
            className="focus-ring rounded-full px-4 py-2 text-[13px] font-semibold text-[var(--accent)] outline-none hover:bg-[var(--accent-fill)]"
          >
            Retry
          </button>
        </div>
      </PageLayout>
    )
  }
  if (detailQuery.isPending) {
    return (
      <PageLayout hideMobileTabBar={mobile}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable data-testid="task-page-scroll">
            <CrumbBar
              boardLabel={boardLabel}
              onBack={goBack}
              ancestors={[]}
              id={id}
              title=""
              onOpenAncestor={openTodo}
              mobile={mobile}
            />
            <div
              data-testid="task-page-grid"
              className={
                mobile
                  ? "flex flex-col px-4 pb-[calc(96px+var(--safe-bottom,0px))] pt-1.5"
                  : "w-full max-w-[920px] px-10 pb-8 pt-2"
              }
            >
              <TaskPageSkeleton mobile={mobile} />
            </div>
          </div>
        </div>
      </PageLayout>
    )
  }

  return (
    // Mobile is a full-screen push (§8): the tab bar yields the bottom edge to
    // the fixed comment bar; back is the condensed crumb's chevron.
    <PageLayout hideMobileTabBar={mobile}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable data-testid="task-page-scroll">
          <CrumbBar
            boardLabel={boardLabel}
            onBack={goBack}
            ancestors={ancestors}
            id={id}
            title={item?.title ?? ""}
            onOpenAncestor={openTodo}
            mobile={mobile}
          />

          <div
            data-testid="task-page-grid"
            className={
              mobile
                ? "flex flex-col px-4 pb-[calc(96px+var(--safe-bottom,0px))] pt-1.5"
                : "w-full max-w-[920px] px-10 pb-8 pt-2"
            }
          >
            <div className="min-w-0">
              {detail && (
                <TaskBanner
                  detail={detail}
                  byName={byName}
                  focusReason={!!routeState.focusBannerReason}
                  busy={setStatus.isPending || decide.isPending}
                  onCommitReason={commitBannerReason}
                  onApprove={(choice) => runDecision("approve", undefined, choice)}
                  onReject={(note) => runDecision("reject", note || undefined)}
                  actions={
                    detail.workItem.status === "blocked" ? (
                      <button
                        type="button"
                        data-testid="task-banner-unblock"
                        onClick={() => pickers.setOpenPicker("status")}
                        className="focus-ring min-h-8 rounded-full bg-[var(--fill-tertiary)] px-3 text-[12.5px] font-semibold text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-secondary)]"
                      >
                        Unblock…
                      </button>
                    ) : detail.workItem.status === "escalated" ? (
                      <>
                        <button
                          type="button"
                          data-testid="task-banner-route"
                          onClick={() => pickers.setOpenPicker("status")}
                          className="focus-ring min-h-8 rounded-full bg-[var(--fill-tertiary)] px-3 text-[12.5px] font-semibold text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-secondary)]"
                        >
                          Route…
                        </button>
                        <button
                          type="button"
                          data-testid="task-banner-reassign"
                          onClick={() => pickers.setOpenPicker("assignee")}
                          className="focus-ring min-h-8 rounded-full px-3 text-[12.5px] font-semibold text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)]"
                        >
                          Reassign…
                        </button>
                      </>
                    ) : undefined
                  }
                />
              )}

              {mobile && (
                <div
                  className="mb-1 text-[12px] tracking-[.04em] text-[var(--text-tertiary)]"
                  style={{ fontFamily: "var(--font-code)" }}
                >
                  {id}
                </div>
              )}

              <TaskTitle
                title={item?.title ?? null}
                mobile={mobile}
                onCommit={(title) => pickers.patchField({ title })}
              />

              {detail && (
                <ChipCluster
                  detail={detail}
                  byName={byName}
                  mobile={mobile}
                  working={hasLiveSession ? working : null}
                  onOpenPicker={(key) => {
                    if (!mobile) setDetailsOpen(true)
                    pickers.setOpenPicker(key)
                  }}
                />
              )}

              <button
                type="button"
                data-testid="task-details-toggle"
                aria-expanded={detailsOpen}
                aria-controls="task-details-content"
                onClick={() => setDetailsOpen((open) => !open)}
                className="focus-ring mt-4 flex min-h-10 w-full items-center gap-2.5 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-3.5 text-left text-[13px] text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-tertiary)]"
              >
                <span className="font-semibold">Details</span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{detailSummary}</span>
                <ChevronDown
                  size={13}
                  strokeWidth={2}
                  aria-hidden
                  className={`flex-none text-[var(--text-quaternary)] transition-transform duration-150 ${detailsOpen ? "rotate-180" : ""}`}
                />
              </button>

              <div id="task-details-content" data-testid="task-details-content" hidden={!detailsOpen}>
                {detail && (
                  <div className={`mt-6 ${mobile ? "" : "max-w-[320px]"}`}>
                    <PropsRail
                      detail={detail}
                      byName={byName}
                      departments={departments.data}
                      rowFor={pickers.rowFor}
                    />
                  </div>
                )}

                <div
                  className="-mx-2 mt-6 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-[var(--fill-quaternary)] focus-within:bg-[var(--fill-quaternary)]"
                  data-testid="task-body"
                >
                  {item && (
                    <BodyEditor
                      body={item.body}
                      editable
                      isDark={isDark}
                      onCommit={(markdown) => pickers.patchField({ body: markdown })}
                    />
                  )}
                </div>

                {item && (
                  <section className="mt-2">
                    <div
                      className="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--text-secondary)]"
                      style={{ fontFamily: "var(--font-code)" }}
                    >
                      Acceptance
                    </div>
                    <AcceptanceChecklist
                      acceptance={item.acceptance}
                      editable
                      onCommit={(next) => pickers.patchField({ acceptance: next })}
                    />
                  </section>
                )}

                {item && (
                  <>
                    <SubTasksSection
                      node={itemNode}
                      parentDepth={item.depth ?? 0}
                      employees={org.data?.employees ?? []}
                      byName={byName}
                      mobile={mobile}
                      onOpenChild={openTodo}
                      onChildStatus={(childId, status) => childStatus.mutate({ childId, status })}
                      onChildAssign={(childId, assignee) => childAssign.mutate({ childId, assignee })}
                      onAddSubTask={(title) => addSubTask.mutate(title)}
                    />
                    <RelationsSection
                      id={item.id}
                      relations={detail?.relations ?? []}
                      onAdd={(srcId, kind, dstId) => addRelation.mutate({ srcId, kind, dstId })}
                      onRemove={(relation) => removeRelation.mutate(relation)}
                    />
                    <AttachmentsSection
                      attachments={attachmentsQuery.data ?? []}
                      byName={byName}
                      onUpload={(files) => uploadAttachments.mutate(files)}
                      onRemove={(attachment) => removeAttachment.mutate(attachment)}
                    />
                  </>
                )}
              </div>

              {detail && (
                <ActivitySection
                  detail={detail}
                  byName={byName}
                  mobile={mobile}
                  isDark={isDark}
                  announce={announce}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {pickers.mobileSheet}

      {callout && (
        <div
          role="status"
          data-testid="task-callout"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-[var(--radius-lg)] bg-[var(--material-thick)] px-4 py-2.5 text-[length:var(--text-footnote)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] backdrop-blur-xl"
        >
          {callout}
        </div>
      )}
    </PageLayout>
  )
}

function TaskPageSkeleton({ mobile }: { mobile: boolean }) {
  const pulse =
    "bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
  return (
    <div data-testid="task-page-skeleton" className="min-w-0" aria-hidden>
      {mobile && <div className={`mb-1 h-3 w-14 rounded-md ${pulse}`} />}
      <div className={`${mobile ? "h-8 w-[82%]" : "h-[38px] w-[68%]"} rounded-[10px] ${pulse}`} />
      <div className={`mt-3 flex ${mobile ? "h-[34px]" : "h-7"} items-center gap-2`}>
        <span className={`h-full w-[92px] rounded-full ${pulse}`} />
        <span className={`h-full w-[116px] rounded-full ${pulse}`} />
        <span className={`h-full w-[84px] rounded-full ${pulse}`} />
      </div>
      <div
        data-testid="task-details-toggle"
        className={`mt-4 h-10 w-full rounded-[var(--radius-lg)] ${pulse}`}
      />
      <div data-testid="task-activity" className="pt-3">
        <div className={`h-4 w-20 rounded-md ${pulse}`} />
        <div className={`mt-3 h-[82px] w-full rounded-[var(--radius-lg)] ${pulse}`} />
        <div className={`mt-3 h-[52px] w-[76%] rounded-[var(--radius-lg)] ${pulse}`} />
      </div>
    </div>
  )
}

/** Inline title edit — borderless, Notes pattern: tap to edit, Enter commits,
 *  Esc reverts. An emptied title reverts rather than committing. */
function TaskTitle({
  title,
  mobile,
  onCommit,
}: {
  title: string | null
  mobile: boolean
  onCommit: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const sizing = mobile
    ? "text-[26px] font-bold leading-[1.2] tracking-[-0.41px]"
    : "text-[28px] font-bold leading-[1.2] tracking-[-0.41px]"
  const bleed = mobile ? "" : "-mx-2 rounded-[10px] px-2 py-0.5"

  if (editing) {
    return (
      <input
        autoFocus
        data-testid="task-title-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          const next = draft.trim()
          if (next && next !== title) onCommit(next)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") {
            e.preventDefault()
            setDraft(title ?? "")
            setEditing(false)
          }
        }}
        aria-label="Todo title"
        className={`${sizing} ${bleed} w-full border-0 bg-[var(--fill-quaternary)] text-[var(--text-primary)] outline-none`}
      />
    )
  }
  return (
    <h1 className={mobile ? "" : "min-w-0"}>
      <button
        type="button"
        data-testid="task-title"
        aria-label="Edit title"
        onClick={() => {
          if (title === null) return
          setDraft(title)
          setEditing(true)
        }}
        className={`${sizing} ${bleed} w-full cursor-text text-left text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--fill-quaternary)]`}
      >
        {title ?? "…"}
      </button>
    </h1>
  )
}

function TaskEmpty({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-[20px] font-bold tracking-[-0.41px] text-[var(--text-primary)]">{message}</div>
      <button
        type="button"
        onClick={onBack}
        className="focus-ring rounded-full px-4 py-2 text-[13px] font-semibold text-[var(--accent)] outline-none hover:bg-[var(--accent-fill)]"
      >
        Back to Todos
      </button>
    </div>
  )
}
