import { useCallback, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Plus, Check, Pause, AlertCircle, Loader2, Workflow as WorkflowGlyph, ChevronRight } from "lucide-react"
import { api, type WorkflowDefinitionSummaryWire } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { queryKeys } from "@/lib/query-keys"
import { lastRunSummary, triggerSummaryOf, type LastRunTone } from "./status-line"

/* GRS-019 — the Workflows LANDING: a calm card list (approved Style A).
 *
 * /workflow no longer drops into one hardcoded graph — it lands here: every
 * editable definition as a card (name · status dot+word · one-line trigger ·
 * last-run glyph+two-words) plus a restrained "+ New Workflow" affordance and
 * an empty state. Tapping a card opens that workflow's canvas at
 * /workflow/:id. This was the operator's #1 complaint (no list, no +). */

export interface WorkflowCardModel {
  id: string
  title: string
  status: WorkflowDefinitionSummaryWire["status"]
  trigger: string
  lastRun: { tone: LastRunTone; label: string }
}

const LIST_DETAIL_CAP = 24

/** kebab-case a workflow name into a safe definition id. */
export function slugifyWorkflowId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function LastRunGlyph({ tone }: { tone: LastRunTone }) {
  const cls = "size-3 shrink-0"
  switch (tone) {
    case "ok":
      return <Check className={cls} style={{ color: "var(--system-green)" }} aria-hidden />
    case "fail":
      return <AlertCircle className={cls} style={{ color: "var(--system-red)" }} aria-hidden />
    case "wait":
      return <Pause className={cls} style={{ color: "var(--system-orange)" }} aria-hidden />
    case "busy":
      return <Loader2 className={`${cls} animate-spin`} style={{ color: "var(--system-blue)" }} aria-hidden />
    default:
      return null
  }
}

export function WorkflowListCard({ card, onOpen }: { card: WorkflowCardModel; onOpen: (id: string) => void }) {
  const paused = card.status !== "active"
  return (
    <button
      type="button"
      data-testid={`wf-card-${card.id}`}
      onClick={() => onOpen(card.id)}
      className="hover-lift flex w-full items-center gap-3.5 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-[18px] py-4 text-left shadow-[var(--shadow-card)]"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--fill-tertiary)]" aria-hidden>
        <WorkflowGlyph className="size-[18px] text-[var(--text-secondary)]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-body)] font-[var(--weight-semibold)] leading-snug text-[var(--text-primary)]">
          {card.title}
        </span>
        <span className="block truncate text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {card.trigger}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="inline-flex items-center gap-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
          <span
            aria-hidden
            className="size-[7px] rounded-full"
            style={{ background: paused ? "var(--text-quaternary)" : "var(--system-green)" }}
          />
          {paused ? "Paused" : "Active"}
        </span>
        <span
          className="inline-flex items-center gap-1.5 text-[length:var(--text-caption1)]"
          style={{ color: card.lastRun.tone === "fail" ? "var(--system-red)" : "var(--text-tertiary)" }}
        >
          <LastRunGlyph tone={card.lastRun.tone} />
          {card.lastRun.label}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-[var(--text-quaternary)] max-[420px]:hidden" aria-hidden />
    </button>
  )
}

/** The "+ New Workflow" dialog: name → POST → open in Edit. Opaque HIG modal. */
export function NewWorkflowDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = slugifyWorkflowId(name)

  const create = useCallback(async () => {
    if (!id || busy) return
    setBusy(true)
    setError(null)
    // Minimal VALID definition: one manual trigger node. The graph grows in Edit.
    const result = await api.createWorkflowDefinition({
      id,
      title: name.trim(),
      status: "active",
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", position: { x: 80, y: 120 }, trigger: { kind: "manual" } },
      ],
      edges: [],
    })
    setBusy(false)
    if (result.ok) onCreated(result.definition.id)
    else setError(result.message)
  }, [id, name, busy, onCreated])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="New workflow">
      <div className="absolute inset-0" style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }} onClick={onClose} aria-hidden />
      <div
        className="relative m-4 w-full max-w-[400px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] animate-scale-in"
      >
        <h2 className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">New Workflow</h2>
        <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          Name it now; add steps in the editor.
        </p>
        <input
          autoFocus
          data-testid="wf-new-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create() }}
          placeholder="e.g. Morning Digest"
          className="apple-input mt-4 w-full"
        />
        {error && (
          <div data-testid="wf-new-error" className="mt-2 text-[length:var(--text-caption1)] text-[var(--system-red)]">
            {error}
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-full px-4 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="wf-new-create"
            disabled={!id || busy}
            onClick={() => void create()}
            className="h-9 rounded-full bg-[var(--accent)] px-5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-transform hover:scale-[0.98] disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  )
}

interface WorkflowListModel {
  cards: WorkflowCardModel[]
  evidenceConfigured: boolean
  evidenceReason: string | null
}

// The list's read is now a React Query so WebSocket `company:changed`
// invalidation of queryKeys.workflows.all refreshes it live (no page reload).
async function loadWorkflowList(): Promise<WorkflowListModel> {
  const list = await api.listWorkflowDefinitions()
  const evidenceConfigured = list.evidenceConfigured
  const evidenceReason = list.evidenceReason ?? null
  if (!evidenceConfigured) return { cards: [], evidenceConfigured, evidenceReason }
  const visible = list.definitions.filter((d) => d.status !== "retired").slice(0, LIST_DETAIL_CAP)
  // One calm line each needs the trigger node + the newest run — fetched in
  // parallel per definition; a single failure degrades that card, not the list.
  const cards = await Promise.all(
    visible.map(async (d): Promise<WorkflowCardModel> => {
      const [defR, runsR] = await Promise.allSettled([
        api.getWorkflowDefinition(d.id),
        api.listWorkflowRuns(d.id),
      ])
      const trigger = defR.status === "fulfilled" ? triggerSummaryOf(defR.value) : "—"
      const lastRun = lastRunSummary(runsR.status === "fulfilled" ? runsR.value.runs[0] : undefined)
      return { id: d.id, title: d.title, status: d.status, trigger, lastRun }
    }),
  )
  return { cards, evidenceConfigured, evidenceReason }
}

export default function WorkflowListPage() {
  useBreadcrumbs([{ label: "Workflows" }])
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const { data, error: queryError } = useQuery({
    queryKey: queryKeys.workflows.all,
    queryFn: loadWorkflowList,
  })
  const cards = data?.cards ?? null
  const evidenceConfigured = data?.evidenceConfigured ?? true
  const evidenceReason = data?.evidenceReason ?? null
  const error = queryError ? (queryError instanceof Error ? queryError.message : "Failed to load workflows") : null

  const open = useCallback((id: string) => navigate(`/workflow/${encodeURIComponent(id)}`), [navigate])
  const activeCount = useMemo(() => cards?.filter((c) => c.status === "active").length ?? 0, [cards])

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[720px] px-5 pb-16 pt-6 md:pt-12">
          <header className="mb-6 flex items-end justify-between gap-3">
            <div>
              <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
                Workflows
              </h1>
              {cards && cards.length > 0 && (
                <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                  {cards.length} {cards.length === 1 ? "workflow" : "workflows"} · {activeCount} active
                </div>
              )}
            </div>
            <button
              type="button"
              data-testid="wf-new"
              onClick={() => setCreating(true)}
              aria-label="New workflow"
              className="inline-flex h-[38px] shrink-0 items-center justify-center gap-1.5 rounded-full px-0 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] transition-transform hover:scale-[0.98] max-md:w-[38px] md:px-4"
              style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
            >
              <Plus className="size-4" aria-hidden />
              <span className="max-md:hidden">New Workflow</span>
            </button>
          </header>

          {error && (
            <div className="rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
              {error}
            </div>
          )}

          {!error && !evidenceConfigured && (
            <div className="rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--system-orange)_10%,transparent)] p-4 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]" data-testid="wf-evidence-error">
              {evidenceReason
                ? <>Workflow storage is misconfigured, so workflows can&rsquo;t be stored: {evidenceReason}</>
                : <>Workflow storage is misconfigured on the gateway, so workflows can&rsquo;t be stored.</>}
            </div>
          )}

          {!error && evidenceConfigured && cards === null && (
            <div className="flex h-40 items-center justify-center text-[var(--text-tertiary)]">Loading workflows…</div>
          )}

          {!error && evidenceConfigured && cards && cards.length > 0 && (
            <div className="flex flex-col gap-3" data-testid="wf-list">
              {cards.map((c) => (
                <WorkflowListCard key={c.id} card={c} onOpen={open} />
              ))}
            </div>
          )}

          {!error && evidenceConfigured && cards && cards.length === 0 && (
            <div className="px-8 py-20 text-center" data-testid="wf-empty">
              <div className="mx-auto mb-5 grid size-[72px] place-items-center rounded-[22px] bg-[var(--fill-tertiary)] shadow-[var(--inset-shine)]" aria-hidden>
                <WorkflowGlyph className="size-8 text-[var(--text-tertiary)]" />
              </div>
              <h2 className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">No workflows yet</h2>
              <p className="mx-auto mt-2 max-w-[300px] text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
                Chain steps, approvals and schedules into repeatable work.
              </p>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-[var(--accent)] px-6 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-transform hover:scale-[0.98]"
              >
                <Plus className="size-4" aria-hidden />
                Create Workflow
              </button>
            </div>
          )}
        </div>
      </div>

      {creating && (
        <NewWorkflowDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            navigate(`/workflow/${encodeURIComponent(id)}?mode=edit`)
          }}
        />
      )}
    </PageLayout>
  )
}
