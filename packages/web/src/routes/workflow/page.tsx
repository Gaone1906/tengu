import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { RefreshCw, ChevronLeft } from "lucide-react"
import { api, type DerivedWorkflow, type EditableWorkflowDefinitionWire, type WorkflowRunView } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { NodeInspector, nodesForRun, nodeStatusColor, type CanvasNode } from "./canvas"
import { WorkflowGraph } from "./graph"
import { InspectorPanel, InspectorSheet } from "./inspector-shell"
import { WorkflowEditView } from "./edit"
import { DefinitionRunView } from "./run-view"

/* GRS-019 — ONE workflow's surface, opened from the /workflow list.
 *
 * Three modes stay distinct and honest: "Live" = the derived dogfood projection
 * (only offered when the gateway serves one for this id); "Runs" = real
 * executions of the editable definition (the default — it exists for every
 * workflow); "Edit" = the definition editor. The canvas is the approved
 * responsive hybrid (spatial React Flow ≥768px, vertical rail below) behind
 * WorkflowGraph; node cards carry a glyph + label + one plain-language line,
 * and everything verbose lives in the inspector. */

type Mode = "run" | "runs" | "edit"
const MODE_LABEL: Record<Mode, string> = { run: "Live", runs: "Runs", edit: "Edit" }

function modeFromParam(p: string | null): Mode | null {
  if (p === "edit") return "edit"
  if (p === "runs") return "runs"
  if (p === "live" || p === "run") return "run"
  return null
}

/* Live ↔ Runs ↔ Edit as a quiet segmented control (HIG): soft fill container,
 * elevated active segment — no loud accent buttons, no border. */
function ModeToggle({ mode, modes, onChange }: { mode: Mode; modes: Mode[]; onChange: (m: Mode) => void }) {
  return (
    <div className="flex items-center rounded-[10px] bg-[var(--fill-tertiary)] p-0.5">
      {modes.map((m) => (
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

/* Wave selector for the derived Live view — quiet chips, no receipt jargon:
 * a status dot + "Wave N". The item/details live in the tooltip + inspector. */
function RunSelector({ runs, selected, onSelect }: { runs: WorkflowRunView[]; selected: number | null; onSelect: (w: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1" data-scrollable>
      {runs.map((r) => {
        const active = r.wave === selected
        const color = nodeStatusColor(r.status)
        return (
          <button
            key={r.wave}
            type="button"
            onClick={() => onSelect(r.wave)}
            title={`Wave ${r.wave} · ${r.item ?? "—"} · ${r.status}`}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[length:var(--text-caption1)] font-[var(--weight-medium)] transition-colors"
            style={{
              background: active ? `color-mix(in srgb, ${color} 14%, transparent)` : "var(--fill-quaternary)",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <span className="size-1.5 rounded-full" style={{ background: color }} />
            Wave {r.wave}
          </button>
        )
      })}
    </div>
  )
}

/** The derived "Live" projection on the hybrid canvas. */
function LiveView({ workflowId }: { workflowId: string }) {
  const [data, setData] = useState<DerivedWorkflow | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedWave, setSelectedWave] = useState<number | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api.getWorkflow(workflowId)
      .then((d) => {
        setData(d)
        setSelectedWave((prev) => prev ?? d.latest?.wave ?? null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load workflow"))
      .finally(() => { setLoading(false); setRefreshing(false) })
  }, [workflowId])

  useEffect(() => { refresh() }, [refresh])

  const selectedRun = data?.runs.find((r) => r.wave === selectedWave) ?? data?.latest ?? null
  const nodes: CanvasNode[] = useMemo(
    () => (selectedRun && data ? nodesForRun(selectedRun, data.triggerSummary, data.definition.orchestrator) : []),
    [selectedRun, data],
  )
  const selectRun = useCallback((w: number) => {
    setSelectedWave(w)
    setSelectedNodeId(null)
  }, [])
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null

  if (loading) {
    return <div className="flex h-40 items-center justify-center text-[var(--text-tertiary)]">Loading workflow…</div>
  }
  if (error) {
    return (
      <div className="m-[var(--space-4)] rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
        {error}
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 px-5 pb-1 pt-1">
        <RunSelector runs={data.runs} selected={selectedWave} onSelect={selectRun} />
        <button
          onClick={refresh}
          disabled={refreshing}
          aria-label="Refresh"
          className="ml-auto grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {nodes.length > 0 ? (
            <WorkflowGraph nodes={nodes} selectedId={selectedNodeId} onSelect={setSelectedNodeId} />
          ) : (
            <div className="flex h-40 items-center justify-center text-[var(--text-tertiary)]">No run selected.</div>
          )}
        </div>

        {selectedNode && (
          <InspectorPanel>
            <NodeInspector
              node={selectedNode}
              evidenceRoot={data.evidenceRoot}
              runItem={selectedRun?.item}
              onClose={() => setSelectedNodeId(null)}
            />
          </InspectorPanel>
        )}
        {selectedNode && (
          <InspectorSheet onClose={() => setSelectedNodeId(null)}>
            <NodeInspector
              node={selectedNode}
              evidenceRoot={data.evidenceRoot}
              runItem={selectedRun?.item}
              onClose={() => setSelectedNodeId(null)}
            />
          </InspectorSheet>
        )}
      </div>
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
  const [editDirty, setEditDirty] = useState(false)

  useBreadcrumbs(useMemo(
    () => [{ label: "Workflows", href: "/workflow" }, { label: definition?.title ?? workflowId }],
    [definition?.title, workflowId],
  ))

  // The definition names the surface (title + status dot). The derived Live
  // projection is only offered when the gateway serves one for this id.
  useEffect(() => {
    let cancelled = false
    api.getWorkflowDefinition(workflowId)
      .then((d) => { if (!cancelled) setDefinition(d) })
      .catch(() => { /* header falls back to the id; Runs view reports errors */ })
    api.listWorkflows()
      .then((w) => { if (!cancelled) setHasDerived(w.workflows.includes(workflowId)) })
      .catch(() => { /* no derived store — Live stays hidden */ })
    return () => { cancelled = true }
  }, [workflowId])

  const modes = useMemo<Mode[]>(() => (hasDerived ? ["run", "runs", "edit"] : ["runs", "edit"]), [hasDerived])

  // Guard: leaving a dirty Edit view discards unsaved changes → confirm first.
  const changeMode = useCallback((next: Mode) => {
    setMode((current) => {
      if (current === "edit" && next !== "edit" && editDirty) {
        if (!window.confirm("Discard unsaved workflow edits?")) return current
      }
      return next
    })
  }, [editDirty])

  const goBack = useCallback(() => {
    if (mode === "edit" && editDirty && !window.confirm("Discard unsaved workflow edits?")) return
    navigate("/workflow")
  }, [mode, editDirty, navigate])

  const paused = definition ? definition.status !== "active" : false

  return (
    <PageLayout>
      <div className="flex h-full flex-col">
        {/* Quiet top bar: back to the list · name + status dot · segmented modes. */}
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
              <ModeToggle mode={mode} modes={modes} onChange={changeMode} />
            </div>
          </div>
          {/* Mobile: the segmented control gets its own centered row (390px-safe). */}
          <div className="mt-2 flex justify-center md:hidden">
            <ModeToggle mode={mode} modes={modes} onChange={changeMode} />
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {mode === "edit" ? (
            <WorkflowEditView workflowId={workflowId} onDirtyChange={setEditDirty} />
          ) : mode === "runs" ? (
            <DefinitionRunView workflowId={workflowId} />
          ) : (
            <LiveView workflowId={workflowId} />
          )}
        </div>
      </div>
    </PageLayout>
  )
}
