import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { ChevronLeft } from "lucide-react"
import { api, type EditableWorkflowDefinitionWire } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { WorkflowEditView } from "./edit"
import { DefinitionRunView } from "./run-view"

/* GRS-019 / canvas-spec §6 — ONE workflow's surface, opened from the /workflow
 * list.
 *
 * Exactly TWO lenses over one spatial truth (n8n's model): "Editor" = the
 * durable definition (arrange, connect, configure); "Executions" = the run
 * list replayed onto the identical canvas geometry. The derived dogfood "Live"
 * projection is not a third mode — it folds into Executions as a pinned first
 * chip when the gateway serves one for this id. Both lenses render the same
 * canvas component with the same positions, so switching moves zero geometry. */

type Mode = "runs" | "edit"
export interface WorkflowLeaveActions {
  save: () => Promise<boolean>
  discard: () => void
}
const MODE_LABEL: Record<Mode, string> = { edit: "Editor", runs: "Executions" }
const MODES: Mode[] = ["edit", "runs"]

function modeFromParam(p: string | null): Mode | null {
  if (p === "edit") return "edit"
  if (p === "runs" || p === "live" || p === "run") return "runs"
  return null
}

/* Editor ↔ Executions as a quiet segmented control (HIG): soft fill container,
 * elevated active segment — no loud accent buttons, no border. */
function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="flex items-center rounded-[10px] bg-[var(--fill-tertiary)] p-0.5">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          data-testid={`wf-mode-${m}`}
          aria-pressed={mode === m}
          className="h-[30px] rounded-lg px-3.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] transition-colors"
          style={
            mode === m
              ? { background: "var(--bg-tertiary)", color: "var(--text-primary)", boxShadow: "var(--shadow-subtle), var(--inset-shine)" }
              : { color: "var(--text-secondary)" }
          }
        >
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  )
}

export default function WorkflowPage() {
  const { id } = useParams<{ id: string }>()
  const workflowId = id ?? ""
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [definition, setDefinition] = useState<EditableWorkflowDefinitionWire | null>(null)
  const [hasDerived, setHasDerived] = useState(false)
  const [mode, setMode] = useState<Mode>(() => modeFromParam(searchParams.get("mode")) ?? "runs")
  const [initialLive] = useState(() => searchParams.get("mode") === "live")
  const [editDirty, setEditDirty] = useState(false)
  const [leaveActions, setLeaveActions] = useState<WorkflowLeaveActions | null>(null)
  const [pendingMode, setPendingMode] = useState<Mode | null>(null)
  const [resolvingLeave, setResolvingLeave] = useState(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const blocker = useBlocker(mode === "edit" && editDirty)

  useEffect(() => {
    if (!editDirty) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [editDirty])

  useBreadcrumbs(useMemo(
    () => [{ label: "Workflows", href: "/workflow" }, { label: definition?.title ?? workflowId }],
    [definition?.title, workflowId],
  ))

  // The definition names the surface (title + status dot). The derived Live
  // projection is only offered when the gateway serves one for this id — it
  // appears as the pinned "Live" chip inside Executions, never a third lens.
  useEffect(() => {
    let cancelled = false
    api.getWorkflowDefinition(workflowId)
      .then((d) => { if (!cancelled) setDefinition(d) })
      .catch(() => { /* header falls back to the id; Executions reports errors */ })
    api.listWorkflows()
      .then((w) => { if (!cancelled) setHasDerived(w.workflows.includes(workflowId)) })
      .catch(() => { /* no derived store — the Live chip stays hidden */ })
    return () => { cancelled = true }
  }, [workflowId])

  useEffect(() => {
    if (blocker.state === "blocked" && !returnFocusRef.current) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
  }, [blocker.state])

  const rememberFocus = useCallback(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [])

  // Local lens changes do not enter router history, so they share the same
  // explicit leave decision while router transitions are handled by useBlocker.
  const changeMode = useCallback((next: Mode) => {
    if (mode === "edit" && next !== "edit" && editDirty) {
      rememberFocus()
      setPendingMode(next)
      return
    }
    setMode(next)
  }, [editDirty, mode, rememberFocus])

  const goBack = useCallback(() => {
    navigate("/workflow")
  }, [navigate])

  const leaveDialogOpen = blocker.state === "blocked" || pendingMode !== null
  const finishLeave = useCallback(() => {
    const nextMode = pendingMode
    setPendingMode(null)
    if (blocker.state === "blocked") blocker.proceed()
    else if (nextMode) setMode(nextMode)
    returnFocusRef.current = null
  }, [blocker, pendingMode])

  const stay = useCallback(() => {
    setPendingMode(null)
    if (blocker.state === "blocked") blocker.reset()
    const target = returnFocusRef.current
    returnFocusRef.current = null
    requestAnimationFrame(() => target?.focus())
  }, [blocker])

  const discardAndLeave = useCallback(() => {
    leaveActions?.discard()
    setEditDirty(false)
    finishLeave()
  }, [finishLeave, leaveActions])

  const saveAndLeave = useCallback(async () => {
    if (!leaveActions || resolvingLeave) return
    setResolvingLeave(true)
    const saved = await leaveActions.save()
    setResolvingLeave(false)
    if (saved) {
      setEditDirty(false)
      finishLeave()
    }
  }, [finishLeave, leaveActions, resolvingLeave])

  const registerLeaveActions = useCallback((actions: WorkflowLeaveActions | null) => {
    setLeaveActions(actions)
  }, [])

  const paused = definition ? definition.status !== "active" : false

  return (
    <PageLayout>
      <div className="flex h-full flex-col">
        {/* Quiet top bar: back to the list · name + status dot · the two lenses. */}
        <div className="px-4 pb-2 pt-3 md:px-5">
          <div className="mx-auto flex max-w-[1200px] items-center gap-2.5">
            <button
              type="button"
              onClick={goBack}
              data-testid="wf-back"
              aria-label="Back to workflows"
              className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
            >
              <ChevronLeft className="size-[18px]" />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h1 className="truncate text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                {definition?.title ?? workflowId}
              </h1>
              <span
                aria-hidden
                className="size-[7px] shrink-0 rounded-full"
                style={{ background: paused ? "var(--text-quaternary)" : "var(--system-green)" }}
                title={paused ? "Paused" : "Active"}
              />
            </div>
            <div className="max-md:hidden">
              <ModeToggle mode={mode} onChange={changeMode} />
            </div>
          </div>
          {/* Mobile: the segmented control gets its own centered row (390px-safe). */}
          <div className="mt-2 flex justify-center md:hidden">
            <ModeToggle mode={mode} onChange={changeMode} />
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {mode === "edit" ? (
            <WorkflowEditView
              workflowId={workflowId}
              onDirtyChange={setEditDirty}
              onLeaveActionsChange={registerLeaveActions}
            />
          ) : (
            <DefinitionRunView workflowId={workflowId} liveAvailable={hasDerived} initialLive={initialLive} />
          )}
        </div>

        {leaveDialogOpen && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_srgb,var(--bg)_52%,transparent)] p-4 backdrop-blur-[3px]">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Unsaved workflow edits"
              className="w-full max-w-sm rounded-[var(--radius-xl)] bg-[var(--material-thick)] p-5 shadow-[var(--shadow-overlay)]"
            >
              <h2 className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                Unsaved workflow edits
              </h2>
              <p className="mt-1.5 text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-secondary)]">
                Save your geometry and workflow changes before leaving?
              </p>
              <div className="mt-5 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={stay}
                  disabled={resolvingLeave}
                  className="min-h-10 rounded-[var(--radius-md)] px-3 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
                >
                  Stay
                </button>
                <button
                  type="button"
                  onClick={discardAndLeave}
                  disabled={resolvingLeave}
                  className="min-h-10 rounded-[var(--radius-md)] px-3 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--system-red)] hover:bg-[color-mix(in_srgb,var(--system-red)_10%,transparent)]"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => void saveAndLeave()}
                  disabled={resolvingLeave || !leaveActions}
                  className="min-h-10 rounded-[var(--radius-md)] bg-[var(--accent)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] disabled:opacity-50"
                >
                  {resolvingLeave ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  )
}
