import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowLeft, Plus } from "lucide-react"
import { api, type WorkItemCompactWire, type WorkItemStatusWire } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import {
  deriveNeedsYou,
  filtersFromSearchParams,
  filtersToSearchParams,
  groupPeople,
  headerCountsFromTotals,
  isDefaultFilters,
  needsYouCount,
  operatorSafeTodoError,
  type TodoFilters,
} from "@/lib/todos"
import { ActiveView } from "./active-view"
import { FilterBar } from "./filter-bar"
import { GroupSkeleton } from "./group"
import { NeedsYouView } from "./needs-you-view"
import { PeopleView } from "./people-view"
import { DetailSheet } from "./detail-sheet"
import { TodoDialog } from "./todo-dialog"
import {
  useLedgerItems,
  usePeopleItems,
  useOpenDetails,
  openIdsOf,
  useOrg,
  useEmployeesByName,
  useDecideApproval,
  useNeedsAttentionItems,
  useEscalateApproval,
  useUpdateWorkItem,
  type LedgerPageDepth,
} from "./use-todos"
import { clearTodoJournalByRef, todoPrivateRef } from "./todo-private-state"

/* One calm open-work ledger. Search and Filter are the persistent controls;
 * Needs you and People become transient focused views instead of peer lenses.
 * Every view keeps the same 840px reading column and short opacity transition. */

type TodoView = "ledger" | "needs" | "people"

interface TodoHistoryState {
  todoRef?: unknown
  todoScroll?: unknown
  todoAnchorRef?: unknown
  todoAnchorOffset?: unknown
  todoPageDepth?: unknown
}

const HISTORY_STATUSES: readonly WorkItemStatusWire[] = [
  "backlog", "assigned", "executing", "blocked", "in_review", "escalated", "done", "cancelled",
]

function historyPageDepth(value: unknown): LedgerPageDepth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const depth: LedgerPageDepth = {}
  for (const status of HISTORY_STATUSES) {
    const candidate = (value as Record<string, unknown>)[status]
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 1) {
      depth[status] = Math.min(50, Math.floor(candidate))
    }
  }
  return Object.keys(depth).length > 0 ? depth : null
}

function cleanTodoHistoryState(state: TodoHistoryState | null): Record<string, unknown> | null {
  if (!state) return null
  const next = { ...state } as Record<string, unknown>
  delete next.todoRef
  delete next.todoScroll
  delete next.todoAnchorRef
  delete next.todoAnchorOffset
  delete next.todoPageDepth
  return Object.keys(next).length > 0 ? next : null
}

export function NewTodoDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const create = useCallback(async () => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.createWorkItem({ title: t })
      onCreated()
    } catch (e) {
      setBusy(false)
      setError(operatorSafeTodoError(e, "Failed to create"))
    }
  }, [title, busy, onCreated])

  return (
    <TodoDialog
      label="New todo"
      onRequestClose={() => {
        if (busy) return
        if (title.trim()) setConfirmDiscard(true)
        else onClose()
      }}
      className="inset-x-3 bottom-3 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-bottom-3 sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[400px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:motion-safe:data-[state=open]:zoom-in-95"
    >
        <h2 className="text-[length:var(--text-title3)] font-semibold text-[var(--text-primary)]">New Todo</h2>
        <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">A unit of work for the company. Assign and route it later.</p>
        <input
          autoFocus
          data-testid="todo-new-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create() }}
          placeholder="e.g. Draft the launch note"
          className="apple-input mt-4 min-h-11 w-full"
        />
        {error && <div className="mt-2 text-[length:var(--text-caption1)] text-[var(--system-red)]">{error}</div>}
        {confirmDiscard && (
          <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] p-3 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            <p>Discard this Todo draft?</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={onClose} className="min-h-11 rounded-full px-3 font-semibold text-[var(--system-red)]">Discard</button>
              <button type="button" onClick={() => setConfirmDiscard(false)} className="min-h-11 rounded-full px-3 text-[var(--text-secondary)]">Keep editing</button>
            </div>
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={() => { if (title.trim()) setConfirmDiscard(true); else onClose() }} className="min-h-11 rounded-full px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)]">
            Cancel
          </button>
          <button
            type="button"
            data-testid="todo-new-create"
            disabled={!title.trim() || busy}
            onClick={() => void create()}
            className="min-h-11 rounded-full bg-[var(--accent)] px-5 text-[length:var(--text-subheadline)] font-semibold text-[var(--accent-contrast)] transition-transform hover:scale-[0.98] disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
    </TodoDialog>
  )
}

export default function TodosPage() {
  useBreadcrumbs([{ label: "Todos" }])
  const qc = useQueryClient()
  const now = Date.now()
  const location = useLocation()
  const navigate = useNavigate()

  const historyState = location.state as TodoHistoryState | null
  const openRef = typeof historyState?.todoRef === "string" ? historyState.todoRef : null
  const anchorRef = typeof historyState?.todoAnchorRef === "string" && /^td_[a-z0-9]+$/i.test(historyState.todoAnchorRef)
    ? historyState.todoAnchorRef
    : null
  const anchorOffset = typeof historyState?.todoAnchorOffset === "number" && Number.isFinite(historyState.todoAnchorOffset)
    ? historyState.todoAnchorOffset
    : null
  const savedPageDepth = historyPageDepth(historyState?.todoPageDepth)
  const savedPageDepthKey = savedPageDepth ? JSON.stringify(savedPageDepth) : ""
  const scrollRestoreKey = `${location.key}:${openRef ?? "closed"}`
  const ledgerScrollRef = useRef<HTMLDivElement>(null)
  const ledgerHeadingRef = useRef<HTMLHeadingElement>(null)
  const lastDetailOpenerRef = useRef<HTMLElement | null>(null)
  const lastDetailScrollRef = useRef<number | null>(
    typeof historyState?.todoScroll === "number" && Number.isFinite(historyState.todoScroll)
      ? historyState.todoScroll
      : null,
  )
  const previousOpenRef = useRef(openRef)
  const restoredScrollRef = useRef<string | null>(null)
  const cancelledScrollRestoreRef = useRef<string | null>(null)
  const pageRestoreRef = useRef<string | null>(null)
  const [restoringPageDepth, setRestoringPageDepth] = useState(Boolean(openRef && savedPageDepth))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [resolving, setResolving] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // Filters live in the URL (§4.3): shareable, refresh-proof.
  const [searchParams, setSearchParams] = useSearchParams()
  const view = (searchParams.get("view") === "needs" || searchParams.get("view") === "people"
    ? searchParams.get("view")
    : "ledger") as TodoView
  const setView = useCallback((next: TodoView) => {
    const params = new URLSearchParams(searchParams)
    if (next === "ledger") params.delete("view")
    else params.set("view", next)
    setSearchParams(params)
  }, [searchParams, setSearchParams])
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams])
  const setFilters = useCallback(
    (next: TodoFilters) => {
      const params = filtersToSearchParams(next)
      if (view !== "ledger") params.set("view", view)
      setSearchParams(params)
    },
    [setSearchParams, view],
  )
  const setSearch = useCallback(
    (query: string | undefined) => {
      const next = { ...filters, q: query }
      const params = filtersToSearchParams(next)
      if (view !== "ledger") params.set("view", view)
      setSearchParams(params, { replace: true })
    },
    [filters, setSearchParams, view],
  )
  const filtered = !isDefaultFilters(filters)

  // The default ledger always loads (header counts come from its server
  // totals); a filtered result adds its own queries on top. "Show N more"
  // appends the NEXT server page for the group's statuses (offset=20, 40, …).
  const baseLedger = useLedgerItems({ status: "open" }, now)
  const filteredLedger = useLedgerItems(filters, now)
  const ledger = filtered ? filteredLedger : baseLedger
  const onLoadMore = useCallback(
    (statuses: readonly WorkItemStatusWire[]) => ledger.loadMore(statuses),
    [ledger],
  )

  const ledgerItems: WorkItemCompactWire[] = useMemo(() => ledger.data?.items ?? [], [ledger.data])

  const openIds = useMemo(() => openIdsOf(ledgerItems), [ledgerItems])
  const details = useOpenDetails(openIds, view === "ledger")
  const needs = useNeedsAttentionItems()
  const org = useOrg()
  const byName = useEmployeesByName(org.data?.employees)
  const decide = useDecideApproval()
  const escalate = useEscalateApproval()
  const update = useUpdateWorkItem()

  // People needs the FULL open set (true per-person counts), not a capped page.
  const peopleItems = usePeopleItems()

  const openId = useMemo(() => {
    if (!openRef) return null
    const candidates = [
      ...(ledger.data?.items ?? []),
      ...(baseLedger.data?.items ?? []),
      ...(needs.data ?? []),
      ...(peopleItems.data ?? []),
    ]
    return candidates.find((item) => todoPrivateRef(item.id) === openRef)?.id ?? null
  }, [baseLedger.data, ledger.data, needs.data, openRef, peopleItems.data])

  // Header counts from the gateway's true totals, never from fetched rows.
  const counts = useMemo(
    () => headerCountsFromTotals(baseLedger.data?.totalsByStatus ?? {}),
    [baseLedger.data],
  )
  const detailById = useMemo(() => new Map((details.data ?? []).map((d) => [d.workItem.id, d])), [details.data])
  const needsYou = useMemo(() => deriveNeedsYou(needs.data ?? []), [needs.data])
  const needsCount = needs.data ? needsYouCount(needsYou) : null
  const people = useMemo(
    () => groupPeople(peopleItems.data ?? [], org.data?.employees ?? []),
    [peopleItems.data, org.data?.employees],
  )
  const filteredOpenTotal = useMemo(
    () => headerCountsFromTotals(ledger.data?.totalsByStatus ?? {}).open,
    [ledger.data],
  )

  const onOpen = useCallback((id: string) => {
    const scroller = ledgerScrollRef.current
    const todoScroll = scroller?.scrollTop ?? 0
    const todoAnchorRef = todoPrivateRef(id)
    const row = scroller?.querySelector<HTMLElement>(`[data-todo-anchor="${todoAnchorRef}"]`)
    const active = document.activeElement
    lastDetailOpenerRef.current = active instanceof HTMLElement && active !== document.body
      ? active
      : row?.querySelector<HTMLElement>("button") ?? null
    const todoAnchorOffset = row && scroller
      ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      : 0
    lastDetailScrollRef.current = todoScroll
    cancelledScrollRestoreRef.current = null
    restoredScrollRef.current = null
    navigate(`${location.pathname}${location.search}`, {
      state: { todoRef: todoAnchorRef, todoScroll, todoAnchorRef, todoAnchorOffset, todoPageDepth: ledger.pageDepth },
    })
  }, [ledger.pageDepth, location.pathname, location.search, navigate])
  const closeDetail = useCallback(() => navigate(-1), [navigate])

  // History keeps only safe row surrogates and the number of loaded pages.
  // Rehydrate those pages before resolving the detail or restoring its anchor.
  useEffect(() => {
    if (!openRef || !savedPageDepth || !ledger.data) {
      if (!openRef || !savedPageDepth) setRestoringPageDepth(false)
      return
    }
    const token = `${location.key}:${openRef}:${savedPageDepthKey}`
    if (pageRestoreRef.current === token) return
    pageRestoreRef.current = token
    let alive = true
    setRestoringPageDepth(true)
    void ledger.restorePageDepth(savedPageDepth).finally(() => {
      if (alive) setRestoringPageDepth(false)
    })
    return () => { alive = false }
    // The restore function is an observer over the same eight ledger queries;
    // the history token and initial-page readiness are the intended triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, openRef, savedPageDepthKey, Boolean(ledger.data)])

  useLayoutEffect(() => {
    const stateScroll = typeof historyState?.todoScroll === "number" && Number.isFinite(historyState.todoScroll)
      ? historyState.todoScroll
      : null
    if (stateScroll != null) lastDetailScrollRef.current = stateScroll
    const detailClosed = !!previousOpenRef.current && !openRef
    const detailOpened = !previousOpenRef.current && !!openRef
    previousOpenRef.current = openRef
    if (restoringPageDepth || restoredScrollRef.current === scrollRestoreKey) return
    const scroller = ledgerScrollRef.current
    if (!scroller || cancelledScrollRestoreRef.current === scrollRestoreKey) return
    if (openRef && anchorRef && anchorOffset != null) {
      const row = scroller.querySelector<HTMLElement>(`[data-todo-anchor="${anchorRef}"]`)
      if (!row) {
        if (stateScroll != null) {
          const hasLayout = scroller.scrollHeight > 0 || scroller.clientHeight > 0
          const maxScroll = hasLayout ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : stateScroll
          scroller.scrollTop = Math.min(Math.max(0, stateScroll), maxScroll)
          restoredScrollRef.current = scrollRestoreKey
        }
        return
      }
      const rowRect = row.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const currentOffset = rowRect.top - scrollerRect.top
      // Layout-less environments cannot resolve an anchor geometry; retain
      // the numeric offset as a compatibility fallback for that case only.
      if (rowRect.height === 0 && scrollerRect.height === 0 && stateScroll != null) scroller.scrollTop = stateScroll
      else scroller.scrollTop += currentOffset - anchorOffset
      restoredScrollRef.current = scrollRestoreKey
      return
    }
    if (!detailClosed && !detailOpened && stateScroll == null) return
    const target = stateScroll ?? lastDetailScrollRef.current
    if (target != null) {
      scroller.scrollTop = target
      restoredScrollRef.current = scrollRestoreKey
    }
  }, [anchorOffset, anchorRef, historyState?.todoScroll, ledger.data, needs.data, openRef, peopleItems.data, restoringPageDepth, scrollRestoreKey, view])

  const cancelPendingScrollRestore = useCallback(() => {
    if (restoredScrollRef.current !== scrollRestoreKey) {
      cancelledScrollRestoreRef.current = scrollRestoreKey
    }
  }, [scrollRestoreKey])
  const onToggle = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const onRename = useCallback(
    (id: string, title: string) =>
      new Promise<void>((resolve) => {
        setEditError(null)
        update.mutate(
          { id, patch: { title } },
          {
            onError: (e) => setEditError(operatorSafeTodoError(e, "Couldn't rename")),
            onSettled: () => resolve(),
          },
        )
      }),
    [update],
  )

  const onRankChange = useCallback(
    (id: string, rank: number) => {
      setEditError(null)
      update.mutate(
        { id, patch: { rank } },
        // The view keeps its local order either way; a failure just means the
        // order won't survive a reload until the gateway ships rank (§7.3).
        { onError: (e) => setEditError(operatorSafeTodoError(e, "Couldn't save the order")) },
      )
    },
    [update],
  )

  const runDecision = useCallback(
    (id: string, decision: "approve" | "reject", note?: string) => {
      setResolving((prev) => new Set(prev).add(id))
      decide.mutate(
        { id, decision, note },
        {
          onSuccess: () => { if (openId === id) closeDetail() },
          onSettled: () =>
            setResolving((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            }),
        },
      )
    },
    [closeDetail, decide, openId],
  )
  const onApprove = useCallback((id: string) => runDecision(id, "approve"), [runDecision])
  const onSendBack = useCallback((id: string, note: string) => runDecision(id, "reject", note || undefined), [runDecision])
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

  const sheetInitial = openId ? detailById.get(openId) : undefined
  const candidateQueriesSettled = !ledger.isLoading && !baseLedger.isLoading && !needs.isLoading && !peopleItems.isLoading
  const candidateQueriesHealthy = !ledger.isError && !baseLedger.isError && !needs.isError && !peopleItems.isError
  const missingRecoveredTodo = Boolean(
    openRef && !openId && !restoringPageDepth && candidateQueriesSettled && candidateQueriesHealthy,
  )
  const discardMissingDraft = useCallback(() => {
    if (openRef) clearTodoJournalByRef(openRef)
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: cleanTodoHistoryState(historyState),
    })
    window.requestAnimationFrame(() => {
      const opener = lastDetailOpenerRef.current
      const target = opener?.isConnected ? opener : ledgerHeadingRef.current
      target?.focus({ preventScroll: true })
    })
  }, [historyState, location.pathname, location.search, navigate, openRef])

  return (
    <PageLayout>
      <div
        ref={ledgerScrollRef}
        data-testid="todo-ledger-scroll"
        className="h-full overflow-y-auto"
        data-scrollable
        onWheel={cancelPendingScrollRestore}
        onTouchStart={cancelPendingScrollRestore}
        onPointerDown={cancelPendingScrollRestore}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            cancelPendingScrollRestore()
          }
        }}
      >
        <div className="mx-auto max-w-[840px] px-5 pb-20 pt-6 md:pt-11">
          <header className="flex items-end justify-between gap-3">
            <div>
              <h1
                ref={ledgerHeadingRef}
                tabIndex={-1}
                className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] outline-none md:text-[length:var(--text-large-title)]"
              >
                Todos
              </h1>
              <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                {counts.open} open · {counts.doneRecent} done this week
              </div>
            </div>
            <button
              type="button"
              data-testid="todo-new"
              onClick={() => setCreating(true)}
              aria-label="New todo"
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] md:px-4"
              style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
            >
              <Plus className="size-4" aria-hidden />
              <span className="max-md:hidden">New Todo</span>
            </button>
          </header>

          <div key={view} className="mt-6 motion-safe:animate-[lensFade_120ms_var(--ease-smooth)]">
            {view === "ledger" && (
              <>
                <FilterBar
                  filters={filters}
                  onChange={setFilters}
                  onSearchChange={setSearch}
                  employees={org.data?.employees ?? []}
                  departments={org.data?.departments ?? []}
                  byName={byName}
                  onPeopleView={() => setView("people")}
                />
                {filtered && ledger.data && (
                  <div className="-mt-3 mb-4 text-[length:var(--text-caption1)] tabular-nums text-[var(--text-tertiary)]">
                    {filters.status === "open"
                      ? `${filteredOpenTotal} of ${counts.open} open`
                      : `${Object.values(ledger.data.totalsByStatus).reduce((sum, value) => sum + (value ?? 0), 0)} matching · ${counts.open} open overall`}
                  </div>
                )}
                {(needsCount ?? 0) > 0 && (
                  <section data-testid="needs-preview" className="mb-6 rounded-[var(--radius-xl)] bg-[var(--fill-quaternary)] p-2">
                    <div className="flex min-h-11 items-center gap-2 px-2">
                      <span className="text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)]">Needs you</span>
                      <span className="tabular-nums text-[length:var(--text-caption1)] text-[var(--system-orange)]">{needsCount}</span>
                      <button type="button" onClick={() => setView("needs")} className="ml-auto min-h-11 rounded-full px-3 text-[length:var(--text-footnote)] font-semibold text-[var(--accent)]">
                        View all
                      </button>
                    </div>
                    <div className="flex flex-col gap-1">
                      {needsYou.slice(0, 3).map((item) => (
                        <button key={item.id} type="button" onClick={() => onOpen(item.id)} className="flex min-h-11 min-w-0 items-center gap-3 rounded-[12px] bg-[var(--bg-secondary)] px-3 text-left hover:bg-[var(--fill-tertiary)]">
                          <span className="min-w-0 flex-1 truncate text-[length:var(--text-subheadline)] font-medium text-[var(--text-primary)]">{item.title}</span>
                          <span className="flex-none text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Review</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {editError && (
                  <div
                    data-testid="todos-edit-error"
                    className="mb-4 rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
                    style={{ background: "var(--fill-quaternary)" }}
                  >
                    {editError}
                  </div>
                )}
                {ledger.isError ? (
                  <div className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
                    {operatorSafeTodoError(ledger.error, "Failed to load todos")}
                  </div>
                ) : ledger.isLoading ? (
                  <>
                    <GroupSkeleton />
                    <GroupSkeleton />
                  </>
                ) : (
                  <ActiveView
                    data={ledger.data ?? { totalsByStatus: {}, items: [] }}
                    filters={filters}
                    detailById={detailById}
                    byName={byName}
                    onOpen={onOpen}
                    onRename={onRename}
                    onRankChange={onRankChange}
                    onLoadMore={onLoadMore}
                    onClearFilters={() => setFilters({ status: "open", q: filters.q })}
                    filtered={filtered}
                    loadingMore={ledger.loadingMore}
                    now={now}
                  />
                )}
              </>
            )}

            {view === "needs" && (
              <>
                <button type="button" onClick={() => setView("ledger")} className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full px-2 text-[length:var(--text-footnote)] font-medium text-[var(--text-secondary)] hover:bg-[var(--fill-quaternary)]">
                  <ArrowLeft size={15} strokeWidth={1.9} aria-hidden /> All todos
                </button>
                <div className="mb-5">
                  <h2 className="text-[length:var(--text-title2)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">Needs you</h2>
                  <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Time-sensitive decisions and blocked work.</p>
                </div>
              {needs.isLoading ? (
                <GroupSkeleton />
              ) : needs.isError ? (
                <div className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
                  {operatorSafeTodoError(needs.error, "Failed to load your inbox")}
                </div>
              ) : (
                <NeedsYouView items={needsYou} byName={byName} resolvingIds={resolving} onApprove={onApprove} onSendBack={onSendBack} onEscalate={onEscalate} onOpen={onOpen} />
              )}
              </>
            )}

            {view === "people" && (
              <>
                <button type="button" onClick={() => setView("ledger")} className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full px-2 text-[length:var(--text-footnote)] font-medium text-[var(--text-secondary)] hover:bg-[var(--fill-quaternary)]">
                  <ArrowLeft size={15} strokeWidth={1.9} aria-hidden /> All todos
                </button>
                <div className="mb-5">
                  <h2 className="text-[length:var(--text-title2)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">By person</h2>
                  <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Open work grouped by owner.</p>
                </div>
              {peopleItems.isLoading ? (
                <GroupSkeleton />
              ) : (
                <PeopleView queues={people} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
              )}
              </>
            )}
          </div>
        </div>
      </div>

      {openId && (
        <DetailSheet
          key={openId}
          id={openId}
          initial={sheetInitial}
          byName={byName}
          employees={org.data?.employees ?? []}
          departments={org.data?.departments ?? []}
          resolving={resolving.has(openId)}
          onApprove={onApprove}
          onSendBack={onSendBack}
          onClose={closeDetail}
        />
      )}

      {missingRecoveredTodo && (
        <TodoDialog
          label="Todo no longer exists"
          onRequestClose={() => {}}
          className="inset-x-3 bottom-3 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-bottom-3 sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[420px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:motion-safe:data-[state=open]:zoom-in-95"
        >
          <h2 className="text-[length:var(--text-title3)] font-semibold text-[var(--text-primary)]">Todo no longer exists</h2>
          <p className="mt-2 text-[length:var(--text-footnote)] leading-relaxed text-[var(--text-secondary)]">
            This Todo may have been removed elsewhere. Its recovered draft is still stored in this tab until you discard it.
          </p>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              autoFocus
              onClick={discardMissingDraft}
              className="min-h-11 rounded-full bg-[var(--fill-secondary)] px-4 text-[length:var(--text-subheadline)] font-semibold text-[var(--system-red)] transition-transform hover:scale-[0.98] active:scale-[0.96]"
            >
              Discard recovered draft
            </button>
          </div>
        </TodoDialog>
      )}

      {creating && (
        <NewTodoDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void qc.invalidateQueries({ queryKey: ["work-items"] })
          }}
        />
      )}
    </PageLayout>
  )
}
