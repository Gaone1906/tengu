import { useCallback, useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { api, type WorkItemCompactWire } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import {
  groupBoard,
  groupPeople,
  deriveNeedsYou,
  needsYouCount,
  headerCounts,
  isOpen,
  isRecentDone,
} from "@/lib/todos"
import { ActiveView } from "./active-view"
import { NeedsYouView } from "./needs-you-view"
import { PeopleView } from "./people-view"
import { DetailSheet } from "./detail-sheet"
import {
  useBoardItems,
  useOpenDetails,
  openIdsOf,
  useOrg,
  useEmployeesByName,
  useDecideApproval,
  useNeedsAttentionItems,
  useEscalateApproval,
} from "./use-todos"

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
    <div className="mb-6 mt-5 flex max-md:justify-center">
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

  const board = useBoardItems()
  const items: WorkItemCompactWire[] = useMemo(() => board.data ?? [], [board.data])
  const openIds = useMemo(() => openIdsOf(items), [items])
  const details = useOpenDetails(openIds, tab === "active")
  const needs = useNeedsAttentionItems()
  const org = useOrg()
  const byName = useEmployeesByName(org.data?.employees)
  const decide = useDecideApproval()
  const escalate = useEscalateApproval()

  // Board = open work + done inside the recent window.
  const boardItems = useMemo(() => items.filter((i) => isOpen(i.status) || isRecentDone(i, now)), [items, now])
  const groups = useMemo(() => groupBoard(boardItems), [boardItems])
  const counts = useMemo(() => headerCounts(items, now), [items, now])
  const detailById = useMemo(() => new Map((details.data ?? []).map((d) => [d.workItem.id, d])), [details.data])
  const needsYou = useMemo(() => deriveNeedsYou(needs.data ?? []), [needs.data])
  const needsCount = needs.data ? needsYouCount(needsYou) : null
  const people = useMemo(() => groupPeople(items, org.data?.employees ?? []), [items, org.data?.employees])
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
        <div className={`mx-auto px-5 pb-20 pt-6 md:pt-11 ${tab === "active" ? "max-w-[1360px]" : "max-w-[720px]"}`}>
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

          {board.isError && (
            <div className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
              {board.error instanceof Error ? board.error.message : "Failed to load todos"}
            </div>
          )}

          {!board.isError && board.isLoading && (
            <div className="flex h-40 items-center justify-center text-[var(--text-tertiary)]">Loading todos…</div>
          )}

          {!board.isError && !board.isLoading && (
            <>
              {tab === "active" &&
                (boardItems.length === 0 ? (
                  <div className="px-8 py-20 text-center text-[var(--text-tertiary)]" data-testid="active-empty">
                    <p className="text-[length:var(--text-subheadline)]">All quiet — no open work right now.</p>
                  </div>
                ) : (
                  <ActiveView groups={groups} detailById={detailById} byName={byName} onOpen={onOpen} now={now} />
                ))}

              {tab === "needs" &&
                (needs.isLoading ? (
                  <div className="flex h-40 items-center justify-center text-[var(--text-tertiary)]">Loading your inbox…</div>
                ) : needs.isError ? (
                  <div className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
                    {needs.error instanceof Error ? needs.error.message : "Failed to load your inbox"}
                  </div>
                ) : (
                  <NeedsYouView items={needsYou} resolvingIds={resolving} onApprove={onApprove} onSendBack={onSendBack} onEscalate={onEscalate} onOpen={onOpen} />
                ))}

              {tab === "people" && <PeopleView queues={people} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />}
            </>
          )}
        </div>
      </div>

      {openId && (
        <DetailSheet
          id={openId}
          initial={sheetInitial}
          byName={byName}
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
