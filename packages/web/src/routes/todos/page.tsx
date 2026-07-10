import { useCallback, useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { Plus } from "lucide-react"
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
  type TodoFilters,
} from "@/lib/todos"
import { ActiveView } from "./active-view"
import { FilterBar } from "./filter-bar"
import { GroupSkeleton } from "./group"
import { NeedsYouView } from "./needs-you-view"
import { PeopleView } from "./people-view"
import { DetailSheet } from "./detail-sheet"
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
  LEDGER_PAGE_SIZE,
  type LedgerWants,
} from "./use-todos"

/* design-todos §2 — the frame. ONE column (max-w 840px) for every lens, so a
 * lens switch moves zero chrome: header block and segmented control have fixed
 * geometry, and only the content region below them swaps (120ms opacity
 * crossfade — no translate, no height animation). The kanban is retired. */

type Tab = "active" | "needs" | "people"

function Segmented({
  tab,
  onTab,
  activeCount,
  needsCount,
  peopleCount,
}: {
  tab: Tab
  onTab: (t: Tab) => void
  activeCount: number
  needsCount: number | null
  peopleCount: number
}) {
  const items: { id: Tab; label: string; count: number | null; alert?: boolean }[] = [
    { id: "active", label: "Active", count: activeCount },
    { id: "needs", label: "Needs you", count: needsCount, alert: (needsCount ?? 0) > 0 },
    { id: "people", label: "People", count: peopleCount },
  ]
  return (
    <div className="mb-3.5 mt-[22px] flex max-md:justify-center">
      <div className="inline-flex gap-0.5 rounded-[12px] bg-[var(--fill-tertiary)] p-[3px]" role="tablist">
        {items.map((it) => {
          const active = tab === it.id
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`todos-tab-${it.id}`}
              onClick={() => onTab(it.id)}
              className={`inline-flex h-[34px] items-center gap-1.5 rounded-[9px] px-[15px] text-[length:var(--text-subheadline)] transition-colors ${
                active
                  ? "bg-[var(--bg-secondary)] font-semibold text-[var(--text-primary)] shadow-[var(--shadow-subtle)]"
                  : "font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {it.label}
              {it.count != null && it.count > 0 && (
                <span
                  className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[9px] px-1.5 text-[length:var(--text-caption2)] font-semibold tabular-nums"
                  style={
                    it.alert
                      ? { background: "var(--accent-fill)", color: "var(--accent)" }
                      : active
                        ? { background: "var(--fill-primary)", color: "var(--text-secondary)" }
                        : { background: "var(--fill-secondary)", color: "var(--text-tertiary)" }
                  }
                >
                  {it.count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function NewTodoDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
      setError(e instanceof Error ? e.message : "Failed to create")
    }
  }, [title, busy, onCreated])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="New todo">
      <div className="absolute inset-0" style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }} onClick={onClose} aria-hidden />
      <div className="relative m-4 w-full max-w-[400px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] animate-scale-in">
        <h2 className="text-[length:var(--text-title3)] font-semibold text-[var(--text-primary)]">New Todo</h2>
        <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">A unit of work for the company. Assign and route it later.</p>
        <input
          autoFocus
          data-testid="todo-new-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create() }}
          placeholder="e.g. Draft the launch note"
          className="apple-input mt-4 w-full"
        />
        {error && <div className="mt-2 text-[length:var(--text-caption1)] text-[var(--system-red)]">{error}</div>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-full px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)]">
            Cancel
          </button>
          <button
            type="button"
            data-testid="todo-new-create"
            disabled={!title.trim() || busy}
            onClick={() => void create()}
            className="h-9 rounded-full bg-[var(--accent)] px-5 text-[length:var(--text-subheadline)] font-semibold text-[var(--accent-contrast)] transition-transform hover:scale-[0.98] disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function TodosPage() {
  useBreadcrumbs([{ label: "Todos" }])
  const qc = useQueryClient()
  const now = Date.now()

  const [tab, setTab] = useState<Tab>("active")
  const [openId, setOpenId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [resolving, setResolving] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // Filters live in the URL (§4.3): shareable, refresh-proof. Changing them
  // resets the per-status page depth back to one page.
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams])
  const [wants, setWants] = useState<LedgerWants>({})
  const setFilters = useCallback(
    (next: TodoFilters) => {
      setWants({})
      setSearchParams(filtersToSearchParams(next), { replace: true })
    },
    [setSearchParams],
  )
  const filtered = !isDefaultFilters(filters)

  // The default ledger always loads (header counts come from its server
  // totals); a filtered Active lens adds its own query on top. `wants` applies
  // to whichever query the Active lens is showing.
  const baseLedger = useLedgerItems({ status: "open" }, now, filtered ? {} : wants)
  const filteredLedger = useLedgerItems(filters, now, wants)
  const ledger = filtered ? filteredLedger : baseLedger

  // "Show N more": raise the want for the group's statuses — the data layer
  // fetches the subsequent server offsets (design-todos §3).
  const onLoadMore = useCallback((statuses: readonly WorkItemStatusWire[]) => {
    setWants((w) => {
      const next = { ...w }
      for (const s of statuses) next[s] = (next[s] ?? LEDGER_PAGE_SIZE) + LEDGER_PAGE_SIZE
      return next
    })
  }, [])

  const ledgerItems: WorkItemCompactWire[] = useMemo(() => ledger.data?.items ?? [], [ledger.data])

  const openIds = useMemo(() => openIdsOf(ledgerItems), [ledgerItems])
  const details = useOpenDetails(openIds, tab === "active")
  const needs = useNeedsAttentionItems()
  const org = useOrg()
  const byName = useEmployeesByName(org.data?.employees)
  const decide = useDecideApproval()
  const escalate = useEscalateApproval()
  const update = useUpdateWorkItem()

  // People needs the FULL open set (true per-person counts), not a capped page.
  const peopleItems = usePeopleItems()

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
  const peopleWithWork = useMemo(() => people.filter((p) => p.openCount > 0).length, [people])

  const onOpen = useCallback((id: string) => setOpenId(id), [])
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
            onError: (e) => setEditError(e instanceof Error ? e.message : "Couldn't rename"),
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
        { onError: (e) => setEditError(e instanceof Error ? e.message : "Couldn't save the order") },
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
          onSuccess: () => setOpenId((cur) => (cur === id ? null : cur)),
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

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[840px] px-5 pb-20 pt-6 md:pt-11">
          <header className="flex items-end justify-between gap-3">
            <div>
              <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
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
              className="inline-flex h-[38px] shrink-0 items-center justify-center gap-1.5 rounded-full text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] max-md:w-[38px] md:px-4"
              style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
            >
              <Plus className="size-4" aria-hidden />
              <span className="max-md:hidden">New Todo</span>
            </button>
          </header>

          <Segmented tab={tab} onTab={setTab} activeCount={counts.open} needsCount={needsCount} peopleCount={peopleWithWork} />

          {/* Content region — everything below the fixed chrome swaps per lens. */}
          <div key={tab} className="motion-safe:animate-[lensFade_120ms_var(--ease-smooth)]">
            {tab === "active" && (
              <>
                <FilterBar
                  filters={filters}
                  onChange={setFilters}
                  employees={org.data?.employees ?? []}
                  departments={org.data?.departments ?? []}
                  byName={byName}
                />
                {editError && (
                  <div
                    data-testid="todos-edit-error"
                    className="mb-4 rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
                    style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
                  >
                    {editError}
                  </div>
                )}
                {ledger.isError ? (
                  <div className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
                    {ledger.error instanceof Error ? ledger.error.message : "Failed to load todos"}
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
                    onClearFilters={() => setFilters({ status: "open" })}
                    filtered={filtered}
                    loadingMore={ledger.isPlaceholderData}
                    now={now}
                  />
                )}
              </>
            )}

            {tab === "needs" &&
              (needs.isLoading ? (
                <GroupSkeleton />
              ) : needs.isError ? (
                <div className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
                  {needs.error instanceof Error ? needs.error.message : "Failed to load your inbox"}
                </div>
              ) : (
                <NeedsYouView items={needsYou} byName={byName} resolvingIds={resolving} onApprove={onApprove} onSendBack={onSendBack} onEscalate={onEscalate} onOpen={onOpen} />
              ))}

            {tab === "people" &&
              (peopleItems.isLoading ? (
                <GroupSkeleton />
              ) : (
                <PeopleView queues={people} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
              ))}
          </div>
        </div>
      </div>

      {openId && (
        <DetailSheet
          id={openId}
          initial={sheetInitial}
          byName={byName}
          employees={org.data?.employees ?? []}
          departments={org.data?.departments ?? []}
          resolving={resolving.has(openId)}
          onApprove={onApprove}
          onSendBack={onSendBack}
          onClose={() => setOpenId(null)}
        />
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
