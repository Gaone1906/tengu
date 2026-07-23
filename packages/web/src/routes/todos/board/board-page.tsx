import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useNavigationType, useParams, useSearchParams } from "react-router-dom"
import { ListFilter, Plus } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { ApiError, type WorkItemCompactWire, type WorkItemStatusWire } from "@/lib/api"
import {
  activeFilterCount,
  compareRank,
  deriveNeedsYou,
  filtersFromSearchParams,
  filtersToSearchParams,
  groupHistory,
  operatorSafeTodoError,
  rankBetween,
  isPositiveTodoVersion,
  type TodoFilters,
} from "@/lib/todos"
import { todoPath } from "@/lib/todo-id"
import {
  useDecideApproval,
  useEscalateApproval,
  useEmployeesByName,
  useNeedsAttentionItems,
  useOpenDetails,
  useOrg,
} from "../use-todos"
import { FilterBar } from "../filter-bar"
import { TodoFilterSheet } from "../todo-filter-sheet"
import { NeedsYouView } from "../needs-you-view"
import { GroupSkeleton } from "../group"
import { NewTodoDialog } from "../page"
import { BoardCard, type CardEnrichment } from "./card"
import { BoardColumn, DragSlot } from "./column"
import { ClosedColumnGroup, ClosedColumnHeader, ClosedRail } from "./closed-rail"
import { BoardSwitcher, departmentTitle } from "./board-switcher"
import {
  boardDetailIds,
  CLOSED_STATUSES,
  EXCEPTION_STATUSES,
  PIPELINE_STATUSES,
  useBoardData,
  useBoardRank,
  useBoardTransition,
  useBoardTrees,
  useCreateSubTask,
  useDepartments,
} from "./use-board"
import { useBoardDrag } from "./use-board-drag"
import {
  boardKey,
  parseBoardParam,
  recallBoardScroll,
  rememberBoardScroll,
} from "./board-route"
import { rollupOf } from "./card"

/* Todos v2 slice 6 — the board surface (design contract:
 * docs/superpowers/design/todos-v2-board — board.html is the visual truth).
 * Stage A: switcher-in-title, 4 pipeline columns + materializing exception
 * columns + folded Closed rail, card anatomy per mock, in-place tree trays,
 * drag (rank within a column, legal status moves across), board-scoped data.
 * The task-page takeover is stage B; mobile polish + cutover are stage C. */

type MobileSegment = "active" | "attention" | "closed"

/** ONE container per breakpoint (never both mounted with CSS hiding one —
 *  duplicate controls break a11y queries and double state). */
const MOBILE_QUERY = "(max-width: 700px)"
function useIsBoardMobile(): boolean {
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

const TREE_OPEN_KEY = "jinn-board-tree-open"

function loadExpandedTrees(): Set<string> {
  try {
    const raw = sessionStorage.getItem(TREE_OPEN_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function saveExpandedTrees(ids: Set<string>): void {
  try {
    sessionStorage.setItem(TREE_OPEN_KEY, JSON.stringify([...ids]))
  } catch {
    /* session-only convenience */
  }
}

export default function TodoBoardPage() {
  const { board: boardParam } = useParams()
  const board = parseBoardParam(boardParam)
  const key = boardKey(board)
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => {
    const f = filtersFromSearchParams(searchParams)
    return { ...f, status: "open" as const } // columns are the status dimension
  }, [searchParams])
  const now = useMemo(() => Date.now(), [filters.date])

  const isAttention = board.kind === "attention"
  const mobile = useIsBoardMobile()
  const data = useBoardData(board, filters, now, !isAttention)
  const departments = useDepartments()
  const org = useOrg()
  const byName = useEmployeesByName(org.data?.employees)
  const needs = useNeedsAttentionItems()
  const needsYou = useMemo(() => deriveNeedsYou(needs.data ?? []), [needs.data])

  // ── Optimistic overlays ───────────────────────────────────────────────────
  const [moves, setMoves] = useState<Map<string, { status: WorkItemStatusWire; index: number }>>(new Map())
  const [rankOverrides, setRankOverrides] = useState<Map<string, number>>(new Map())
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

  /** Effective per-status card lists: server data + optimistic moves/ranks. */
  const itemsByStatus = useMemo(() => {
    const out: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}
    const allStatuses = [...PIPELINE_STATUSES, ...EXCEPTION_STATUSES, ...CLOSED_STATUSES]
    const withRank = (item: WorkItemCompactWire): WorkItemCompactWire => {
      const rank = rankOverrides.get(item.id)
      return rank === undefined ? item : { ...item, rank }
    }
    for (const status of allStatuses) {
      const base = (data.columns[status]?.items ?? [])
        .filter((item) => {
          const move = moves.get(item.id)
          return !move || move.status === status
        })
        .map(withRank)
      base.sort(compareRank)
      out[status] = base
    }
    // Insert moved cards into their optimistic column at the drop index.
    for (const [id, move] of moves) {
      const source = allStatuses.flatMap((s) => data.columns[s]?.items ?? []).find((item) => item.id === id)
      if (!source || source.status === move.status) continue
      const list = out[move.status] ?? []
      const index = Math.min(Math.max(move.index, 0), list.length)
      list.splice(index, 0, { ...withRank(source), status: move.status })
      out[move.status] = list
    }
    return out
  }, [data.columns, moves, rankOverrides])

  // Drop an optimistic move once the server agrees (poll/refetch landed).
  useEffect(() => {
    if (moves.size === 0) return
    const next = new Map(moves)
    let changed = false
    for (const [id, move] of moves) {
      const serverItem = (data.columns[move.status]?.items ?? []).find((item) => item.id === id)
      if (serverItem) {
        next.delete(id)
        changed = true
      }
    }
    if (changed) setMoves(next)
  }, [data.columns, moves])

  // ── Enrichment (trees carry priority/roll-up/spend; details carry reasons) ─
  const detailIds = useMemo(() => boardDetailIds(data.columns), [data.columns])
  const trees = useBoardTrees(detailIds)
  const reasonIds = useMemo(
    () =>
      (["executing", "blocked", "escalated"] as const).flatMap((status) =>
        (data.columns[status]?.items ?? []).map((item) => item.id),
      ),
    [data.columns],
  )
  const details = useOpenDetails(reasonIds)
  const detailById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof details.data>[number]>()
    for (const d of details.data ?? []) map.set(d.workItem.id, d)
    return map
  }, [details.data])
  const enrichmentOf = useCallback(
    (id: string): CardEnrichment => ({ tree: trees.data?.get(id), detail: detailById.get(id) }),
    [trees.data, detailById],
  )

  // ── Tree expansion (session-persisted, per item) ────────────────────────────
  const [expandedTrees, setExpandedTrees] = useState<Set<string>>(loadExpandedTrees)
  const toggleTree = useCallback((id: string) => {
    setExpandedTrees((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveExpandedTrees(next)
      return next
    })
  }, [])

  // ── Mutations ───────────────────────────────────────────────────────────────
  const transition = useBoardTransition()
  const rankEdit = useBoardRank()
  const createSubTask = useCreateSubTask()

  const commitTransition = useCallback(
    (item: WorkItemCompactWire, to: WorkItemStatusWire, index: number) => {
      // The drop position is a promise: once the status PUT lands, write the
      // rank at the landing slot too (Stage-A review F3) so the next refetch
      // never reorders a drop the gateway accepted.
      const siblings = (itemsByStatus[to] ?? []).filter((it) => it.id !== item.id)
      const before = index > 0 ? siblings[Math.min(index, siblings.length) - 1] : null
      const after = index < siblings.length ? siblings[index] : null
      const rank = rankBetween(before?.rank ?? null, after?.rank ?? null)
      setMoves((prev) => new Map(prev).set(item.id, { status: to, index }))
      setRankOverrides((prev) => new Map(prev).set(item.id, rank))
      const clearRankOverride = () =>
        setRankOverrides((prev) => {
          const next = new Map(prev)
          next.delete(item.id)
          return next
        })
      transition.mutate(
        { id: item.id, status: to },
        {
          onSuccess: (result) => {
            // A drop into Blocked/Escalated commits immediately, then opens the
            // task page with the banner's reason field focused (design-doc §5 —
            // the reason is asked for, never demanded by a modal). Review F6:
            // an exception item must never silently sit reason-less.
            if (to === "blocked" || to === "escalated") {
              navigate(todoPath(item.id), { state: { fromBoard: key, focusBannerReason: true } })
            }
            const version = result.workItem?.version
            if (!isPositiveTodoVersion(version)) {
              clearRankOverride()
              return
            }
            rankEdit.mutate(
              { id: item.id, rank, expectedVersion: version },
              {
                onSettled: clearRankOverride,
                // A rank refusal only costs the position, never the accepted
                // transition — stay quiet unless the operator would notice.
              },
            )
          },
          onError: (error) => {
            clearRankOverride()
            setMoves((prev) => {
              const next = new Map(prev)
              next.delete(item.id)
              return next
            })
            announce(operatorSafeTodoError(error, error instanceof ApiError ? error.message : "The gateway refused the move"))
          },
        },
      )
    },
    [transition, rankEdit, announce, itemsByStatus, navigate, key],
  )

  const commitRank = useCallback(
    (item: WorkItemCompactWire, beforeRank: number | null, afterRank: number | null) => {
      if (!isPositiveTodoVersion(item.version)) return
      const rank = rankBetween(beforeRank, afterRank)
      setRankOverrides((prev) => new Map(prev).set(item.id, rank))
      rankEdit.mutate(
        { id: item.id, rank, expectedVersion: item.version },
        {
          onSettled: () => {
            setRankOverrides((prev) => {
              const next = new Map(prev)
              next.delete(item.id)
              return next
            })
          },
          onError: (error) => announce(operatorSafeTodoError(error, "Reorder failed")),
        },
      )
    },
    [rankEdit, announce],
  )

  const openChildrenOf = useCallback(
    (id: string): number => {
      const tree = trees.data?.get(id)
      if (!tree) return 0
      const roll = rollupOf(tree, tree.root.status)
      return roll ? roll.total - roll.closed : 0
    },
    [trees.data],
  )

  const { drag, registerColumn, liftPointerDown, reducedMotion } = useBoardDrag(itemsByStatus, openChildrenOf, {
    onRank: commitRank,
    onTransition: (item, to, index) => commitTransition(item, to, index),
  })

  // ── Keyboard rank (⌘/Ctrl + arrows) with SR announcements ──────────────────
  const liveRef = useRef<HTMLSpanElement>(null)
  const onCardKeyDown = useCallback(
    (event: React.KeyboardEvent, item: WorkItemCompactWire) => {
      if (!(event.metaKey || event.ctrlKey) || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
      event.preventDefault()
      const list = itemsByStatus[item.status] ?? []
      const index = list.findIndex((it) => it.id === item.id)
      if (index < 0) return
      const target = event.key === "ArrowUp" ? index - 1 : index + 1
      if (target < 0 || target >= list.length) return
      const without = list.filter((it) => it.id !== item.id)
      const before = target > 0 ? without[target - 1] : null
      const after = target < without.length ? without[target] : null
      commitRank(item, before?.rank ?? null, after?.rank ?? null)
      if (liveRef.current) {
        liveRef.current.textContent = `${item.id} moved to position ${target + 1} of ${list.length}`
      }
    },
    [itemsByStatus, commitRank],
  )

  // ── Scroll cache (per board, restored on POP) ───────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) rememberBoardScroll(key, el.scrollTop)
  }, [key])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = navigationType === "POP" ? recallBoardScroll(key) : 0
  }, [key, navigationType])

  // ── Page chrome state ───────────────────────────────────────────────────────
  const [creating, setCreating] = useState<null | { department?: string; askAssignee?: boolean }>(null)
  const [closedOpen, setClosedOpen] = useState(false)
  const [segment, setSegment] = useState<MobileSegment>("active")
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false)
  useEffect(() => {
    setClosedOpen(false)
    setSegment("active")
    setMobileFilterOpen(false)
  }, [key])

  const setFilters = useCallback(
    (next: TodoFilters) => {
      const params = filtersToSearchParams(next)
      params.delete("status")
      setSearchParams(params, { replace: false })
    },
    [setSearchParams],
  )
  const setSearch = useCallback(
    (q: string | undefined) => {
      const params = filtersToSearchParams({ ...filters, q })
      params.delete("status")
      setSearchParams(params, { replace: true })
    },
    [filters, setSearchParams],
  )

  // Opening a card carries the board context so the task page's crumb knows
  // its way back (the board name is the back affordance).
  const onOpen = useCallback((id: string) => navigate(todoPath(id), { state: { fromBoard: key } }), [navigate, key])

  // ── Attention board actions (reuses the shipped inbox) ─────────────────────
  const decide = useDecideApproval()
  const escalate = useEscalateApproval()
  const [resolving, setResolving] = useState<Set<string>>(new Set())
  const runDecision = useCallback(
    (id: string, decision: "approve" | "reject", note?: string) => {
      setResolving((prev) => new Set(prev).add(id))
      decide.mutate(
        { id, decision, note },
        {
          onSettled: () =>
            setResolving((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            }),
        },
      )
    },
    [decide],
  )
  const onEscalate = useCallback(
    (id: string) => {
      setResolving((prev) => new Set(prev).add(id))
      escalate.mutate(id, {
        onSettled: () =>
          setResolving((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          }),
      })
    },
    [escalate],
  )

  // ── Derived chrome ──────────────────────────────────────────────────────────
  const deptSummary = board.kind === "department" ? departments.data?.find((d) => d.slug === board.slug) : undefined
  const title =
    board.kind === "my" ? "My requests"
    : board.kind === "attention" ? "Attention"
    : board.kind === "everything" ? "Everything"
    : departmentTitle(board.slug)
  const blockedTotal = data.columns.blocked?.total ?? 0
  const escalatedTotal = data.columns.escalated?.total ?? 0
  const attentionSegmentItems = useMemo(
    () =>
      [...(itemsByStatus.blocked ?? []), ...(itemsByStatus.escalated ?? []),
        ...PIPELINE_STATUSES.flatMap((s) => (itemsByStatus[s] ?? []).filter((item) => item.approvalState === "pending"))],
    [itemsByStatus],
  )
  // §8: the mobile Closed segment shows done/cancelled grouped by DATE (the
  // rows' own discs carry which) — the desktop rail's status groups stay
  // desktop-only.
  const closedHistory = useMemo(
    () => groupHistory([...(itemsByStatus.done ?? []), ...(itemsByStatus.cancelled ?? [])], now),
    [itemsByStatus, now],
  )

  const visibleStatuses: WorkItemStatusWire[] = useMemo(() => {
    const exceptions = EXCEPTION_STATUSES.filter(
      (status) => (data.columns[status]?.total ?? 0) > 0 || (itemsByStatus[status]?.length ?? 0) > 0,
    )
    return [...PIPELINE_STATUSES, ...exceptions]
  }, [data.columns, itemsByStatus])

  const renderCards = (status: WorkItemStatusWire) => {
    const items = (itemsByStatus[status] ?? []).filter((item) => item.id !== drag?.id)
    const slotIndex = drag && drag.overStatus === status ? Math.min(drag.overIndex, items.length) : null
    const nodes: React.ReactNode[] = []
    items.forEach((item, index) => {
      if (slotIndex === index) nodes.push(<DragSlot key="slot" height={drag!.height} />)
      nodes.push(
        <div key={item.id} onKeyDown={(e) => onCardKeyDown(e, item)}>
          <BoardCard
            item={item}
            enrichment={enrichmentOf(item.id)}
            byName={byName}
            expanded={expandedTrees.has(item.id)}
            onToggleTree={toggleTree}
            onOpen={onOpen}
            onOpenChild={onOpen}
            onAddSubTask={(parentId, subTitle) =>
              createSubTask.mutate({ parentId, title: subTitle }, {
                onError: (error) => announce(operatorSafeTodoError(error, "Failed to add the sub-task")),
              })
            }
            onLiftPointerDown={(event) => liftPointerDown(event, item)}
          />
        </div>,
      )
    })
    if (slotIndex !== null && slotIndex >= items.length) nodes.push(<DragSlot key="slot" height={drag!.height} />)
    return nodes
  }

  const columnFor = (status: WorkItemStatusWire) => {
    const column = data.columns[status]
    const items = itemsByStatus[status] ?? []
    const quickAdd =
      status === "backlog"
        ? () => setCreating({ department: board.kind === "department" ? board.slug : undefined })
        : status === "assigned"
          ? () => setCreating({ department: board.kind === "department" ? board.slug : undefined, askAssignee: true })
          : undefined
    return (
      <BoardColumn
        key={status}
        status={status}
        count={column?.total ?? 0}
        orderKey={items.map((item) => item.id).join(",")}
        onQuickAdd={quickAdd}
        hasMore={column?.hasMore ?? false}
        remaining={Math.max(0, (column?.total ?? 0) - items.length)}
        loadMore={column?.loadMore ?? (() => {})}
        loadingMore={column?.loadingMore ?? false}
        drag={drag}
        registerColumn={registerColumn}
      >
        {renderCards(status)}
      </BoardColumn>
    )
  }

  return (
    <PageLayout>
      <div className="flex h-full min-h-0 flex-col">
        {/* ── Header (fixed; the board scrolls under it) ── */}
        <header className="flex-none px-5 pt-6 max-[700px]:pt-[calc(24px+var(--safe-top,0px))] md:px-10 md:pt-8">
          <div className="flex items-start gap-4">
            <div className="min-w-0">
              <BoardSwitcher board={board} title={title} departments={departments.data} attentionCount={needsYou.length} />
              <div className="mt-1 flex items-center gap-2 text-[13px] text-[var(--text-tertiary)]">
                {deptSummary && (
                  <>
                    <span className="text-[11px] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}>
                      {deptSummary.prefix}
                    </span>
                    <Dot />
                  </>
                )}
                {isAttention ? (
                  <span>{needsYou.length} waiting</span>
                ) : (
                  <>
                    <span>{data.openTotal} open</span>
                    {blockedTotal > 0 && (
                      <>
                        <Dot />
                        <span>{blockedTotal} blocked</span>
                      </>
                    )}
                    {escalatedTotal > 0 && (
                      <>
                        <Dot />
                        <span>{escalatedTotal} escalated</span>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              data-testid="todo-new"
              onClick={() => setCreating({ department: board.kind === "department" ? board.slug : undefined })}
              aria-label="New todo"
              className="ml-auto inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-full text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] md:px-[18px]"
              style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
            >
              <Plus className="size-4" aria-hidden />
              <span className="max-md:hidden">New Todo</span>
            </button>
          </div>

          {!isAttention && !mobile && (
            <div className="mt-4">
              <FilterBar
                filters={filters}
                onChange={setFilters}
                onSearchChange={setSearch}
                employees={org.data?.employees ?? []}
                departments={board.kind === "everything" || board.kind === "my" ? org.data?.departments ?? [] : []}
                byName={byName}
                hideStatus
                hideDepartment={board.kind === "department"}
              />
            </div>
          )}

          {/* Mobile segments (§8): Active · Attention · Closed. The desktop
              filter chips fold into the Active segment's filter glyph — the
              raised Active pill carries it, and re-tapping the selected pill
              opens the filter sheet (the mobile filtering entry point,
              Stage-A review F5). */}
          {!isAttention && mobile && (
            <div className="mt-4 flex gap-2 overflow-x-auto" role="tablist" aria-label="Board segments">
              {(["active", "attention", "closed"] as const).map((seg) => {
                const count = seg === "active" ? data.openTotal : seg === "attention" ? blockedTotal + escalatedTotal : data.closedTotal
                const label = seg === "active" ? "Active" : seg === "attention" ? "Attention" : "Closed"
                const on = segment === seg
                const filtersOn = activeFilterCount(filters) > 0 || !!filters.q
                return (
                  <button
                    key={seg}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    data-testid={`board-segment-${seg}`}
                    aria-label={seg === "active" ? `Active — tap again to filter` : undefined}
                    onClick={() => {
                      if (seg === "active" && segment === "active") setMobileFilterOpen(true)
                      else setSegment(seg)
                    }}
                    className={`flex h-[34px] flex-none items-center gap-[7px] rounded-[17px] px-3.5 text-[14px] font-semibold ${
                      on ? "bg-[var(--bg-secondary)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)]"
                    }`}
                    style={on ? { boxShadow: "var(--shadow-ambient), var(--shadow-subtle), var(--inset-shine)" } : undefined}
                  >
                    {seg === "active" && (
                      <ListFilter
                        size={13}
                        strokeWidth={2.2}
                        aria-hidden
                        className={filtersOn ? "text-[var(--accent)]" : undefined}
                      />
                    )}
                    {label}
                    <span className="text-[12px] font-medium tabular-nums text-[var(--text-quaternary)]">{count}</span>
                  </button>
                )
              })}
            </div>
          )}
        </header>

        {/* ── Content ── */}
        {isAttention ? (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="todo-board-scroll"
            data-scrollable
            className="min-h-0 flex-1 overflow-y-auto px-5 pb-20 pt-5 md:px-10"
          >
            <div className="max-w-[680px]">
              {needs.isLoading ? (
                <GroupSkeleton />
              ) : needs.isError ? (
                <div className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
                  {operatorSafeTodoError(needs.error, "Failed to load your inbox")}
                </div>
              ) : (
                <NeedsYouView
                  items={needsYou}
                  byName={byName}
                  resolvingIds={resolving}
                  onApprove={(id) => runDecision(id, "approve")}
                  onSendBack={(id, note) => runDecision(id, "reject", note || undefined)}
                  onEscalate={onEscalate}
                  onOpen={onOpen}
                />
              )}
            </div>
          </div>
        ) : (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="todo-board-scroll"
            data-scrollable
            className="min-h-0 flex-1 overflow-auto"
          >
            {!mobile ? (
            <div className="flex min-h-full items-start gap-3 px-10 pb-8 pt-5">
              {visibleStatuses.map((status) => columnFor(status))}
              {closedOpen ? (
                <section className="flex w-[262px] min-w-[238px] flex-none flex-col gap-3" data-testid="board-closed-column">
                  <ClosedColumnHeader count={data.closedTotal} onCollapse={() => setClosedOpen(false)} />
                  {CLOSED_STATUSES.map((status) => (
                    <ClosedColumnGroup
                      key={status}
                      status={status as "done" | "cancelled"}
                      count={data.columns[status]?.total ?? 0}
                      hasMore={data.columns[status]?.hasMore ?? false}
                      loadMore={data.columns[status]?.loadMore ?? (() => {})}
                      loadingMore={data.columns[status]?.loadingMore ?? false}
                    >
                      <div ref={registerColumn(status)} className="flex flex-col gap-2">
                        {renderCards(status)}
                      </div>
                    </ClosedColumnGroup>
                  ))}
                </section>
              ) : (
                <ClosedRail count={data.closedTotal} onExpand={() => setClosedOpen(true)} />
              )}
            </div>
            ) : (
            <div className="flex flex-col gap-[18px] px-4 pb-24 pt-2">
              {segment === "active" && visibleStatuses.map((status) => columnFor(status))}
              {segment === "attention" && (
                <div className="flex flex-col">
                  {attentionSegmentItems.length === 0 ? (
                    <EmptyCaption text="All quiet." />
                  ) : (
                    attentionSegmentItems.map((item) => (
                      <BoardCard
                        key={item.id}
                        item={item}
                        enrichment={enrichmentOf(item.id)}
                        byName={byName}
                        expanded={false}
                        onToggleTree={toggleTree}
                        onOpen={onOpen}
                        onOpenChild={onOpen}
                        onAddSubTask={() => {}}
                      />
                    ))
                  )}
                </div>
              )}
              {segment === "closed" && (
                closedHistory.length === 0 ? (
                  <EmptyCaption text="Nothing closed yet." />
                ) : (
                  <>
                    {closedHistory.map((group) => (
                      <section key={group.bucket} data-testid={`board-closed-${group.bucket}`}>
                        <div className="flex items-center gap-2 px-0.5 pb-0.5 text-[13px] font-semibold text-[var(--text-secondary)]">
                          {group.label}
                          <span className="text-[12px] font-normal tabular-nums text-[var(--text-quaternary)]">
                            {group.items.length}
                          </span>
                        </div>
                        <div className="flex flex-col">
                          {group.items.map((item) => (
                            <BoardCard
                              key={item.id}
                              item={item}
                              enrichment={enrichmentOf(item.id)}
                              byName={byName}
                              expanded={false}
                              onToggleTree={toggleTree}
                              onOpen={onOpen}
                              onOpenChild={onOpen}
                              onAddSubTask={() => {}}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                    {CLOSED_STATUSES.filter((status) => data.columns[status]?.hasMore).map((status) => (
                      <button
                        key={status}
                        type="button"
                        data-testid={`board-show-more-${status}`}
                        onClick={data.columns[status]?.loadMore ?? (() => {})}
                        disabled={data.columns[status]?.loadingMore ?? false}
                        className="focus-ring min-h-11 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-3 text-left text-[12px] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-tertiary)]"
                      >
                        {(data.columns[status]?.loadingMore ?? false)
                          ? "Loading…"
                          : `Show more ${status === "done" ? "done" : "cancelled"}`}
                      </button>
                    ))}
                  </>
                )
              )}
            </div>
            )}
          </div>
        )}
      </div>

      {/* Drag ghost — lifted card follows the pointer (scale 1.02 + 1.2° tilt). */}
      {drag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50"
          style={{
            left: drag.x,
            top: drag.y,
            width: drag.width,
            transform: reducedMotion ? undefined : "scale(1.02) rotate(1.2deg)",
          }}
        >
          <BoardCard
            item={drag.item}
            enrichment={enrichmentOf(drag.id)}
            byName={byName}
            expanded={false}
            onToggleTree={() => {}}
            onOpen={() => {}}
            onOpenChild={() => {}}
            onAddSubTask={() => {}}
            ghost
          />
        </div>
      )}

      {/* Transient refusal callout — the gateway's words. */}
      {callout && (
        <div
          role="status"
          data-testid="board-callout"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-[var(--radius-lg)] bg-[var(--material-thick)] px-4 py-2.5 text-[length:var(--text-footnote)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] backdrop-blur-xl"
        >
          {callout}
        </div>
      )}
      <span ref={liveRef} aria-live="polite" className="sr-only" />

      {creating && (
        <NewTodoDialog
          onClose={() => setCreating(null)}
          onCreated={() => setCreating(null)}
          defaults={{ department: creating.department, askAssignee: creating.askAssignee, employees: org.data?.employees ?? [] }}
        />
      )}

      {/* Mobile filtering entry (F5): the Active pill's glyph opens the same
          filter grammar as the desktop chips, scoped like FilterBar. */}
      {mobile && mobileFilterOpen && (
        <TodoFilterSheet
          filters={filters}
          onChange={setFilters}
          employees={org.data?.employees ?? []}
          departments={board.kind === "everything" || board.kind === "my" ? org.data?.departments ?? [] : []}
          byName={byName}
          onClose={() => setMobileFilterOpen(false)}
          hideStatus
          hideDepartment={board.kind === "department"}
        />
      )}
    </PageLayout>
  )
}

function Dot() {
  return <span aria-hidden className="size-[2.5px] rounded-full bg-[var(--text-quaternary)]" />
}

function EmptyCaption({ text }: { text: string }) {
  return <div className="px-2 py-6 text-[13px] text-[var(--text-tertiary)]">{text}</div>
}
