import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft } from "lucide-react"
import { api, type EditableWorkflowDefinitionWire } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { queryKeys } from "@/lib/query-keys"
import { WorkflowEditView } from "./edit"
import { DefinitionRunView } from "./run-view"
import { WorkflowLeaveDialog } from "./workflow-leave-dialog"

/** A workflow-run deep link encodes a run id; keep only safe id characters. */
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

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

function currentFocusReturnTarget(): HTMLElement | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!active) return null
  const menu = active.closest<HTMLElement>("[role=menu]")
  const triggerId = menu?.getAttribute("aria-labelledby")
  const menuTrigger = triggerId ? document.getElementById(triggerId) : null
  return menuTrigger instanceof HTMLElement ? menuTrigger : active
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
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedModeParam = searchParams.get("mode")
  const requestedMode = modeFromParam(requestedModeParam) ?? "runs"
  const initialLive = requestedModeParam === "live"

  const [hasDerived, setHasDerived] = useState(false)
  const [mode, setMode] = useState<Mode>(requestedMode)
  // A run deep link is only meaningful in the Executions lens; validate its id.
  const runParamRaw = searchParams.get("run")
  const runParam = mode === "runs" && runParamRaw && RUN_ID_RE.test(runParamRaw) ? runParamRaw : null
  const [editDirty, setEditDirty] = useState(false)
  const [leaveActions, setLeaveActions] = useState<WorkflowLeaveActions | null>(null)
  const [pendingMode, setPendingMode] = useState<Mode | null>(null)
  const [resolvingLeave, setResolvingLeave] = useState(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const blocker = useBlocker(mode === "edit" && editDirty)
  const leaveDialogOpen = blocker.state === "blocked" || pendingMode !== null
  if (blocker.state === "blocked" && !returnFocusRef.current) {
    // Capture before the modal's mount autofocus runs. A passive effect would
    // observe the Stay button instead of the control that initiated navigation.
    returnFocusRef.current = currentFocusReturnTarget()
  }

  useEffect(() => {
    if (!editDirty || leaveDialogOpen) return
    const rememberStableFocus = () => {
      const target = currentFocusReturnTarget()
      if (target && target !== document.body) returnFocusRef.current = target
    }
    document.addEventListener("focusin", rememberStableFocus)
    return () => document.removeEventListener("focusin", rememberStableFocus)
  }, [editDirty, leaveDialogOpen])

  useEffect(() => {
    if (!editDirty) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [editDirty])

  // The definition names the surface (title + status dot). It is a React Query so
  // WebSocket `company:changed` invalidation of queryKeys.workflows.definition
  // refreshes the header live after an edit elsewhere.
  const definitionQuery = useQuery({
    queryKey: queryKeys.workflows.definition(workflowId),
    queryFn: () => api.getWorkflowDefinition(workflowId),
    enabled: Boolean(workflowId),
  })
  const definition: EditableWorkflowDefinitionWire | null = definitionQuery.data ?? null

  useBreadcrumbs(useMemo(
    () => [{ label: "Workflows", href: "/workflow" }, { label: definition?.title ?? workflowId }],
    [definition?.title, workflowId],
  ))

  // The derived Live projection is only offered when the gateway serves one for
  // this id — the pinned "Live" chip inside Executions, never a third lens. It is
  // a separate derived store, not part of the definition/run key space.
  useEffect(() => {
    let cancelled = false
    api.listWorkflows()
      .then((w) => { if (!cancelled) setHasDerived(w.workflows.includes(workflowId)) })
      .catch(() => { /* no derived store — the Live chip stays hidden */ })
    return () => { cancelled = true }
  }, [workflowId])

  useEffect(() => {
    setMode(requestedMode)
  }, [requestedMode, workflowId])

  const rememberFocus = useCallback(() => {
    returnFocusRef.current = currentFocusReturnTarget()
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

  // Selecting a run writes it into the URL as a real history entry (replace:false)
  // so browser back restores the prior run; a fresh run and refresh both persist.
  const handleSelectRun = useCallback((runId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("mode", "runs")
      next.set("run", runId)
      return next
    }, { replace: false })
  }, [setSearchParams])

  // Editing has no run selection — drop a stale ?run= so the Edit URL stays clean.
  useEffect(() => {
    if (mode !== "edit" || !searchParams.has("run")) return
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete("run")
      return next
    }, { replace: true })
  }, [mode, searchParams, setSearchParams])

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
    if (!leaveDialogOpen) {
      returnFocusRef.current = null
      requestAnimationFrame(() => target?.focus())
    }
  }, [blocker, leaveDialogOpen])

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
              key={`edit:${workflowId}`}
              workflowId={workflowId}
              onDirtyChange={setEditDirty}
              onLeaveActionsChange={registerLeaveActions}
            />
          ) : (
            <DefinitionRunView
              key={`runs:${workflowId}:${initialLive ? "live" : "runs"}`}
              workflowId={workflowId}
              liveAvailable={hasDerived}
              initialLive={initialLive}
              initialRunId={runParam}
              onSelectRun={handleSelectRun}
            />
          )}
        </div>

        <WorkflowLeaveDialog
          open={leaveDialogOpen}
          resolving={resolvingLeave}
          canSave={Boolean(leaveActions)}
          returnFocusRef={returnFocusRef}
          onStay={stay}
          onDiscard={discardAndLeave}
          onSave={() => void saveAndLeave()}
        />
      </div>
    </PageLayout>
  )
}
