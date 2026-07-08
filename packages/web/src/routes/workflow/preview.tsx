import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { RefreshCw, Plus, Workflow as WorkflowGlyph, Sparkles, X } from "lucide-react"
import { WorkflowCanvas } from "./canvas"
import { PREVIEW_FIXTURES, HERO_FIXTURE } from "./preview-fixtures"
import { WorkflowListCard, NewWorkflowDialog, type WorkflowCardModel } from "./list"

/* GRS-019c — dev-only screenshot harness (import.meta.env.DEV route only).
 *
 * Renders the approved mock scenarios through the REAL production components
 * (WorkflowCanvas, WorkflowListCard, NewWorkflowDialog) so captures reflect
 * shipped UI, not a separate mock. No data fetch, no live coupling — safe to run
 * without a gateway. `?scenario=` picks the surface; `?theme=dark|light` stamps
 * the theme for deterministic captures. */

const CARDS: WorkflowCardModel[] = [
  { id: "sample-autonomy", title: "Sample Autonomy", status: "active", trigger: "Every 2 hours · until Jul 7", lastRun: { tone: "wait", label: "Waiting for you" } },
  { id: "daily-standup", title: "Daily standup digest", status: "paused", trigger: "Daily at 09:00", lastRun: { tone: "ok", label: "Ran 8h ago" } },
  { id: "support-triage", title: "Support triage", status: "active", trigger: "Every 15 min", lastRun: { tone: "ok", label: "Ran 3m ago" } },
  { id: "blog-pipeline", title: "Blog pipeline", status: "active", trigger: "Weekdays at 07:30", lastRun: { tone: "fail", label: "Failed 1d ago" } },
]

function TopBar({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3 px-6 pb-3 pt-5">
      <h1 className="text-[length:var(--text-title2)] font-[var(--weight-semibold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">{title}</h1>
      <span className="size-[9px] rounded-full" style={{ background: "var(--accent)" }} />
      <div className="flex-1" />
      <div className="inline-flex items-center rounded-[10px] bg-[var(--fill-tertiary)] p-0.5">
        <span className="rounded-lg px-3.5 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)]">Editor</span>
        <span className="rounded-lg px-3.5 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]" style={{ background: "var(--bg-tertiary)", boxShadow: "var(--shadow-subtle)" }}>Executions</span>
      </div>
      <span className="inline-flex items-center gap-2 rounded-[11px] bg-[var(--fill-tertiary)] px-3.5 py-2 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-secondary)]">
        <RefreshCw className="size-[15px]" /> Run #128
      </span>
    </div>
  )
}

/** Faithful reproduction of the mock's mobile edit sheet — the node's plain-English
 * task + a HIG "Uses" value group (engine / employee / tools / runs-after). */
function EditSheet() {
  const build = HERO_FIXTURE.nodes.find((n) => n.id === "build")!
  const rows = [
    { k: "Engine", v: "Claude · Opus" },
    { k: "Employee", v: "Jinn Dev" },
    { k: "Tools", v: "Shell · Tests" },
    { k: "Runs after", v: "Plan the work" },
  ]
  return (
    <div className="absolute inset-x-0 bottom-0 flex max-h-[86%] flex-col rounded-t-[var(--radius-2xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)]">
      <div className="flex justify-center pt-2.5"><span className="h-[5px] w-9 rounded-full bg-[var(--text-quaternary)]" /></div>
      <div className="flex items-center gap-3 px-5 pb-3 pt-3">
        <span className="grid size-11 place-items-center rounded-[12px]" style={{ background: "color-mix(in srgb, var(--system-purple) 16%, transparent)", color: "var(--system-purple)" }}><Sparkles className="size-6" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{build.title}</div>
          <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Engine step · runs on Claude Opus</div>
        </div>
        <span className="grid size-8 place-items-center rounded-[10px] bg-[var(--fill-secondary)] text-[var(--text-secondary)]"><X className="size-4" /></span>
      </div>
      <div className="space-y-5 px-5 pb-5 pt-2">
        <div>
          <div className="mb-2 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">What should happen</div>
          <div className="rounded-[var(--radius-md)] bg-[var(--bg)] p-3.5 text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-secondary)] shadow-[inset_0_0_0_0.5px_var(--separator)]">
            Implement the failing spec, write the tests, and run the suite until everything is green.
          </div>
        </div>
        <div>
          <div className="mb-2 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">Uses</div>
          <div className="overflow-hidden rounded-[var(--radius-md)] bg-[var(--bg)] shadow-[inset_0_0_0_0.5px_var(--separator)]">
            {rows.map((r, i) => (
              <div key={r.k} className="flex items-center px-3.5 py-3.5" style={i > 0 ? { borderTop: "0.5px solid var(--separator)" } : undefined}>
                <span className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">{r.k}</span>
                <span className="ml-auto text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{r.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-auto flex gap-2.5 px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-2">
        <span className="flex-1 rounded-[13px] bg-[var(--fill-secondary)] py-3.5 text-center text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Cancel</span>
        <span className="flex-1 rounded-[13px] py-3.5 text-center text-[length:var(--text-body)] font-[var(--weight-semibold)]" style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}>Save</span>
      </div>
    </div>
  )
}

function ListSurface({ empty, create }: { empty?: boolean; create?: boolean }) {
  return (
    <div className="mx-auto max-w-[720px] px-5 pb-16 pt-10">
      <header className="mb-6 flex items-end justify-between gap-3">
        <div>
          <h1 className="font-[var(--font-display)] text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">Workflows</h1>
          {!empty && <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">4 workflows · 3 active</div>}
        </div>
        <span className="inline-flex h-[38px] items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]" style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}>
          <Plus className="size-4" /> New Workflow
        </span>
      </header>
      {empty ? (
        <div className="px-8 py-20 text-center">
          <div className="mx-auto mb-5 grid size-[72px] place-items-center rounded-[22px] bg-[var(--fill-tertiary)] shadow-[var(--inset-shine)]"><WorkflowGlyph className="size-8 text-[var(--text-tertiary)]" /></div>
          <h2 className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">No workflows yet</h2>
          <p className="mx-auto mt-2 max-w-[300px] text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">Chain steps, approvals and schedules into repeatable work.</p>
          <span className="mt-6 inline-flex h-11 items-center gap-2 rounded-full px-6 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]" style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}><Plus className="size-4" /> Create Workflow</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {CARDS.map((c) => <WorkflowListCard key={c.id} card={c} onOpen={() => {}} />)}
        </div>
      )}
      {create && <NewWorkflowDialog onClose={() => {}} onCreated={() => {}} />}
    </div>
  )
}

export default function WorkflowPreviewPage() {
  const [params] = useSearchParams()
  const scenario = params.get("scenario") ?? "hero"
  const theme = params.get("theme")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme)
  }, [theme])

  if (scenario === "list" || scenario === "empty" || scenario === "create") {
    return (
      <div className="h-screen w-screen overflow-y-auto bg-[var(--bg)]">
        <ListSurface empty={scenario === "empty"} create={scenario === "create"} />
      </div>
    )
  }

  if (scenario === "inspector") {
    return (
      <div className="relative h-screen w-screen overflow-hidden bg-[var(--bg)]">
        <div className="pointer-events-none absolute inset-0" style={{ background: "color-mix(in srgb, var(--bg) 30%, transparent)" }}>
          <WorkflowCanvas nodes={HERO_FIXTURE.nodes} edges={HERO_FIXTURE.edges} selectedId="build" onSelect={() => {}} minimap={false} controls={false} />
        </div>
        <div className="absolute inset-0" style={{ background: "color-mix(in srgb, var(--bg) 45%, transparent)" }} />
        <EditSheet />
      </div>
    )
  }

  const fixture = PREVIEW_FIXTURES[scenario] ?? HERO_FIXTURE
  return (
    <div className="flex h-screen w-screen flex-col bg-[var(--bg)]">
      <TopBar title={fixture.title} />
      <div className="min-h-0 flex-1">
        <WorkflowCanvas nodes={fixture.nodes} edges={fixture.edges} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
    </div>
  )
}
