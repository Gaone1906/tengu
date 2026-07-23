import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { api, ApiError, type WorkItemDetailWire, type WorkItemStatusWire, type WorkItemTreeNodeWire } from "@/lib/api"
import { STATUS_LABEL, operatorSafeTodoError, publicWorkItemReference } from "@/lib/todos"
import { isTodoId, todoPath } from "@/lib/todo-id"
import { PageLayout } from "@/components/page-layout"
import { MarkdownView } from "@/components/markdown-view"
import { useTheme } from "@/routes/providers"
import {
  useDecideApproval,
  useEmployeesByName,
  useOrg,
  useSetWorkItemStatus,
  useTodoById,
} from "../use-todos"
import { useDepartments } from "../board/use-board"
import { parseBoardParam, boardPath, boardKey } from "../board/board-route"
import { departmentTitle } from "../board/board-switcher"
import { CrumbBar, type CrumbAncestor } from "./crumb-bar"
import { TaskBanner } from "./banner"
import { PropsRail } from "./props-rail"
import { ChipCluster } from "./chip-cluster"
import { useTaskPickers } from "./use-task-pickers"
import { formatRelativeTime } from "../util"

/* Todos v2 slice 6 stage B — the opened task as a full-page takeover of the
 * todos route (design-doc §7, mock task-detail.html = the visual truth).
 * Two columns on one 96px content spine: main (≤760px) — banner zone, title,
 * meta, body, sections, activity — and the 288px chrome-free properties rail,
 * 72px gutter. The URL is the todo; back/breadcrumb returns to the board with
 * its scroll preserved (POP → the board's own scroll cache). */

const MOBILE_QUERY = "(max-width: 700px)"
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
    (decision: "approve" | "reject", note?: string) => {
      if (!item) return
      decide.mutate(
        { id: item.id, decision, note },
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
  const sessionRefLabel = item ? publicWorkItemReference(item.sourceRef) : null

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

  return (
    <PageLayout>
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
                : "grid max-w-[1360px] gap-x-[72px] pb-24 pl-[96px] pr-[64px] pt-6"
            }
            style={mobile ? undefined : { gridTemplateColumns: "minmax(0, 760px) 288px" }}
          >
            {/* ── Main column ── */}
            <div className="min-w-0">
              {detail && (
                <TaskBanner
                  detail={detail}
                  byName={byName}
                  focusReason={!!routeState.focusBannerReason}
                  busy={setStatus.isPending || decide.isPending}
                  onCommitReason={commitBannerReason}
                  onApprove={() => runDecision("approve")}
                  onSendBack={(note) => runDecision("reject", note || undefined)}
                  onReject={() => runDecision("reject")}
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

              {/* Title on the spine (text at 96px; the block bleeds -8px). */}
              <h1
                data-testid="task-title"
                className={
                  mobile
                    ? "text-[26px] font-bold leading-[1.2] tracking-[-0.41px] text-[var(--text-primary)]"
                    : "-mx-2 rounded-[10px] px-2 py-0.5 text-[28px] font-bold leading-[1.2] tracking-[-0.41px] text-[var(--text-primary)]"
                }
              >
                {item?.title ?? "…"}
              </h1>

              {!mobile && item && (
                <div className="ml-px mt-2 flex items-center gap-2 text-[13px] text-[var(--text-tertiary)]" data-testid="task-meta-line">
                  <span>{STATUS_LABEL[item.status]}</span>
                  {item.status === "executing" && hasLiveSession && working && (
                    <>
                      <MetaDot />
                      <span className="flex items-center gap-1.5 font-medium text-[var(--system-blue)]">
                        <span
                          className="size-1.5 rounded-full bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]"
                          aria-hidden
                        />
                        Working · {working}
                      </span>
                    </>
                  )}
                  {item.status === "executing" && hasLiveSession && sessionRefLabel && (
                    <>
                      <MetaDot />
                      <span className="text-[11px]" style={{ fontFamily: "var(--font-code)" }}>
                        {sessionRefLabel}
                      </span>
                    </>
                  )}
                  {item.status !== "executing" && <><MetaDot /><span>updated {formatRelativeTime(item.updatedAt)}</span></>}
                </div>
              )}

              {/* Body — live-markdown editing lands with the body editor task;
                  reading renders through the shared MarkdownView. */}
              <div className="-mx-2 mt-6 rounded-[10px] px-2 py-1.5" data-testid="task-body">
                {item?.body ? (
                  <MarkdownView content={item.body} isDark={isDark} />
                ) : (
                  <p className="text-[16px] leading-[1.6] text-[var(--text-quaternary)]">
                    Describe the work — type ## for a heading, - for a list
                  </p>
                )}
              </div>
            </div>

            {/* ── Properties rail (desktop) / chip cluster (mobile, §8) ── */}
            {mobile ? (
              detail && (
                <ChipCluster
                  detail={detail}
                  byName={byName}
                  departments={departments.data}
                  onOpenPicker={pickers.setOpenPicker}
                />
              )
            ) : (
              <div className="row-span-2">
                {detail && (
                  <PropsRail detail={detail} byName={byName} departments={departments.data} rowFor={pickers.rowFor} />
                )}
              </div>
            )}
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

function MetaDot() {
  return <span aria-hidden className="size-[2.5px] rounded-full bg-[var(--text-quaternary)]" />
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
