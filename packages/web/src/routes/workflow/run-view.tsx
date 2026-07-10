import { useCallback, useEffect, useMemo, useState } from "react"
import { RefreshCw, Clock, X, ExternalLink, Bell, Loader2, CheckCircle2, AlertCircle } from "lucide-react"
import {
  api,
  type WorkflowRunWire, type WorkflowRunSummaryWire, type RunStepReceiptWire,
  type WorkflowNodeWire, type DerivedWorkflow, type WorkflowRunView,
} from "@/lib/api"
import {
  buildCanvasNodes, nodeStatusColor, InspectorStateCircle, deriveDisplayFields,
  nodesForRun, NodeInspector, type CanvasNode, type CanvasEdgeSpec,
} from "./canvas"
import { WorkflowGraph } from "./graph"
import { InspectorPanel, InspectorSheet } from "./inspector-shell"
import { nodeStatusLine, relativeTime, triggerSummaryOf } from "./status-line"

/* GRS-011d-2c-ui — render a real workflow RUN on the canvas.
 *
 * The backend (GRS-011d-2c) executes an editable definition: it spawns the
 * mapped sessions and PARKS the run on a human-approval gate, persisting a
 * WorkflowRun record served by GET /api/workflow-definitions/:id/runs[/:runId].
 * This is the UI half — the phone-demo beat: a run selector, the run graph on
 * the same GRS-010c WorkflowCanvas, honest spawn states (a spawned step is
 * "running", never a green "done"), and the parked gate rendered as a calm
 * doorbell whose inspector says what approval is awaited and links the real
 * spawned sessions.
 *
 * Pure/prop-driven mapper + inspector so they unit-test without a gateway;
 * DefinitionRunView owns fetching + run selection. The parked doorbell carries
 * Approve/Reject (GRS-014e) wired to the resolve-gate API via the container's
 * onResolveGate — the inspector itself stays transport-free. */

/** Human deep-link to a spawned session. Chat lives at "/", which reads ?session=. */
export function sessionHref(sessionId: string): string {
  return `/?session=${encodeURIComponent(sessionId)}`
}

/** Map a step receipt's execution status to a canvas node status.
 * spawned → "running" (blue spinner, NOT a green check — spawn ≠ done);
 * inline / checkpoint → "passed" (genuinely completed inside the run);
 * error → "blocked" (red). GRS-014a adds the reserved v2 step-machine states
 * (emitted from GRS-014b): done → passed, running/dispatching → running,
 * failed → blocked, pending/skipped → pending. */
export function stepNodeStatus(receipt: RunStepReceiptWire): string {
  switch (receipt.status) {
    case "spawned": return "running"
    case "error": return "blocked"
    case "inline":
    case "checkpoint": return "passed"
    case "routed": return "passed" // GRS-016c: the switch took its decision
    case "fired": return "passed" // GRS-016d: settled at spawn by declaration (badged distinctly in the inspector)
    case "done": return "passed"
    case "running":
    case "dispatching": return "running"
    case "waiting": return "running" // GRS-016d: the run is genuinely holding here
    case "failed": return "blocked"
    case "pending":
    case "skipped": return "pending"
    default: return "pending"
  }
}

/** A step's role-chip category (reuses existing canvas tints): a spawned/errored
 * step is doing work (implement), an inline step is the orchestrator, a checkpoint
 * is a gate. The precise actor (codex/jimbo) is shown as `who`, not the chip. */
function stepRole(receipt: RunStepReceiptWire): string {
  if (receipt.status === "checkpoint") return "gate"
  if (receipt.actor === null) return "orchestrate"
  return "implement"
}

function stepWho(receipt: RunStepReceiptWire): string {
  if (receipt.actor) return receipt.actor.ref
  if (receipt.status === "checkpoint") return "auto-checkpoint"
  return "orchestrator (inline)"
}

/** Build the ordered canvas nodes for a run: synthetic trigger + step receipts
 * (declaration order — how the executor walks the graph today) + the parked
 * doorbell when the run is parked (the shared builder promotes the gate's own
 * receipt node, or appends a synthetic for v1 records). Thin adapter over
 * buildCanvasNodes (GRS-013 / KISS simplify item 2) — only the honest receipt→
 * status mapping and the definition-snapshot position lookup live here. */
export function nodesForDefinitionRun(run: WorkflowRunWire): CanvasNode[] {
  // Definitions carry x/y (GRS-013 #6); the run's frozen snapshot maps them to
  // receipt nodeIds. Runs without a snapshot fall back to the canvas lane.
  const positions = new Map(run.definitionSnapshot?.nodes.map((n) => [n.id, n.position]) ?? [])
  const triggerPosition = run.definitionSnapshot?.nodes.find((n) => n.type === "trigger")?.position
  // Loop rounds (GRS-014e) repeat nodeIds with per-round receipts; the canvas keeps ONE
  // node per nodeId showing the LATEST round's state (per-round history lives in the run
  // record and the inspector's round marker). A Map keyed by nodeId keeps the last entry.
  const latestByNode = new Map(run.steps.map((r) => [r.nodeId, r]))
  // The frozen definition node carries the actor / model / task / switch outputs
  // that drive the per-type visual (GRS-019c); look them up by receipt nodeId.
  const snapNodes = new Map(run.definitionSnapshot?.nodes.map((n) => [n.id, n]) ?? [])
  const snapEdges = run.definitionSnapshot?.edges ?? []
  const displayFor = (nodeId: string) => {
    const def = snapNodes.get(nodeId)
    return def ? deriveDisplayFields(def, snapEdges.filter((e) => e.from === nodeId)) : {}
  }
  // The chip reads the human schedule ("Every 2 hours"), derived from the
  // frozen snapshot's trigger node — never a raw cron or "scheduled run".
  const triggerSource = "source" in run.trigger ? run.trigger.source : run.trigger.kind
  const triggerEvent = "source" in run.trigger ? run.trigger.event : run.trigger.kind
  const triggerFireRef = "source" in run.trigger
    ? run.trigger.fireRef
    : run.trigger.kind === "schedule"
      ? run.trigger.fireIso
      : undefined
  const cadence = run.definitionSnapshot
    ? triggerSummaryOf(run.definitionSnapshot)
    : triggerSource === "schedule" ? "Scheduled" : triggerSource === "manual" ? "Manual" : triggerSource
  return buildCanvasNodes({
    trigger: {
      title: "Trigger",
      role: "trigger",
      who: triggerSource,
      status: "passed",
      cadence,
      detail: triggerFireRef
        ? `${triggerEvent} (${triggerFireRef})`
        : `${triggerEvent} trigger`,
      position: triggerPosition,
    },
    steps: [...latestByNode.values()].map((r) => ({
      id: r.nodeId,
      title: r.label,
      role: stepRole(r),
      who: stepWho(r),
      status: stepNodeStatus(r),
      detail: (r.round ?? 1) > 1 ? `${r.detail ? `${r.detail} · ` : ""}round ${r.round}` : r.detail,
      position: positions.get(r.nodeId),
      ...displayFor(r.nodeId),
    })),
    parked: run.status === "parked" && run.parked
      ? {
          nodeId: run.parked.nodeId,
          description: run.parked.description,
          position: run.parked.nodeId ? positions.get(run.parked.nodeId) : undefined,
        }
      : undefined,
  })
}

/** Per-edge item counts derived from the run's receipt evidence — the web-side
 * mirror of the executor's edge-activity frame (advance.ts): a switch's frozen
 * `route` selects its out-edges; an error lane is taken exactly when its source
 * terminally failed under onError:'error-edge' (and that failure darkens the
 * source's NORMAL out-edges); done/inline/checkpoint receipts pass one item per
 * round; `fired` (output: none) passes control but declares NOTHING flows — the
 * taken-but-empty path that renders "0 items". Unsettled (pending / running /
 * waiting) and skipped sources have not passed control, so their lanes carry no
 * pill. Trigger out-edges always carry the one firing payload — the trigger has
 * fired for any run we can see. Absent from the map = lane not taken. Pure. */
export function edgeItemsForRun(run: WorkflowRunWire): Map<string, number> {
  const counts = new Map<string, number>()
  const snap = run.definitionSnapshot
  if (!snap) return counts
  const receipts = new Map<string, RunStepReceiptWire[]>()
  for (const r of run.steps) {
    const list = receipts.get(r.nodeId)
    if (list) list.push(r)
    else receipts.set(r.nodeId, [r])
  }
  const errorEdgeNodes = new Set(snap.nodes.filter((n) => n.options?.onError === "error-edge").map((n) => n.id))
  const triggerIds = new Set(snap.nodes.filter((n) => n.type === "trigger").map((n) => n.id))
  for (const e of snap.edges) {
    if (triggerIds.has(e.from)) {
      counts.set(e.id, 1)
      continue
    }
    let taken = false
    let items = 0
    for (const r of receipts.get(e.from) ?? []) {
      const failedHere = r.status === "failed" || r.status === "error"
      if (e.lane === "error") {
        if (failedHere && errorEdgeNodes.has(e.from)) { taken = true; items += 1 }
        continue
      }
      if (failedHere) continue // the failure killed the run or took the error lane
      if (r.status === "routed") {
        if (Array.isArray(r.route) && r.route.includes(e.id)) { taken = true; items += 1 }
        continue
      }
      if (r.status === "done" || r.status === "inline" || r.status === "checkpoint" || r.status === "spawned") {
        taken = true
        items += 1
      } else if (r.status === "fired") {
        taken = true // declared fire-and-forget: the lane was walked, zero items flowed
      }
    }
    if (taken) counts.set(e.id, items)
  }
  return counts
}

/** The run's REAL topology for the spatial canvas (GRS-019): the frozen
 * snapshot's edges, with the snapshot's trigger node id remapped to the
 * synthetic canvas trigger. Switch/IF out-edges carry their output-row index
 * (same lane!=='error' ordering the port rows derive from) so each branch wire
 * leaves its row's port on the card wall. Taken lanes carry their receipt-
 * derived item count (edgeItemsForRun) so the run view renders the pills —
 * `0 items` included; untaken lanes carry none. Edges to nodes the run never
 * materialized are dropped by the canvas. Pure — unit-tests without a DOM. */
export function edgesForDefinitionRun(run: WorkflowRunWire, nodes: CanvasNode[]): CanvasEdgeSpec[] {
  const snap = run.definitionSnapshot
  if (!snap) return []
  const canvasTrigger = nodes.find((n) => n.kind === "trigger")?.id
  const snapTrigger = snap.nodes.find((n) => n.type === "trigger")?.id
  const remap = (id: string) => (snapTrigger && id === snapTrigger && canvasTrigger ? canvasTrigger : id)
  const outsBySwitch = new Map<string, string[]>()
  for (const n of snap.nodes) {
    if (n.type !== "switch") continue
    outsBySwitch.set(n.id, snap.edges.filter((e) => e.from === n.id && e.lane !== "error").map((e) => e.id))
  }
  const itemCounts = edgeItemsForRun(run)
  return snap.edges.map((e) => {
    const spec: CanvasEdgeSpec = { id: e.id, from: remap(e.from), to: remap(e.to) }
    if (e.lane !== undefined) spec.lane = e.lane
    const outs = outsBySwitch.get(e.from)
    if (outs) {
      const i = outs.indexOf(e.id)
      if (i >= 0) spec.outIndex = i
    }
    const items = itemCounts.get(e.id)
    if (items !== undefined) spec.items = items
    return spec
  })
}

/* Run-level status pill. `dispatched` (the read-time mapping of a legacy v1 `passed`,
 * GRS-014a) gets an explanatory tooltip — it is the one status whose name alone
 * doesn't say "completion unknown". */
export function RunStatusPill({ status }: { status: string }) {
  const color = nodeStatusColor(status)
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[length:var(--text-caption1)] font-[var(--weight-semibold)]"
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
      title={status === "dispatched" ? "Walk finished; sessions were dispatched fire-and-forget — completion unknown" : undefined}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {status}
    </span>
  )
}

/* Run selector: pick one execution. Newest first (the API already sorts).
 * When the gateway serves a derived dogfood projection for this workflow it
 * appears as a PINNED first chip ("Live") — it IS an execution view, not a
 * third mode (spec §6). */
export function DefinitionRunSelector({
  runs,
  selected,
  onSelect,
  liveAvailable = false,
  liveSelected = false,
  onSelectLive,
}: {
  runs: WorkflowRunSummaryWire[]
  selected: string | null
  onSelect: (runId: string) => void
  liveAvailable?: boolean
  liveSelected?: boolean
  onSelectLive?: () => void
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1" data-scrollable>
      {liveAvailable && (
        <button
          type="button"
          onClick={onSelectLive}
          data-testid="wf-run-live"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[length:var(--text-caption1)] font-[var(--weight-medium)] transition-colors"
          style={{
            background: liveSelected ? "color-mix(in srgb, var(--system-green) 18%, transparent)" : "var(--fill-quaternary)",
            color: liveSelected ? "var(--text-primary)" : "var(--text-secondary)",
            boxShadow: liveSelected ? "var(--inset-shine)" : undefined,
          }}
        >
          <span className="size-1.5 rounded-full" style={{ background: "var(--system-green)" }} />
          Live
        </button>
      )}
      {runs.map((r) => {
        const active = r.runId === selected
        const color = nodeStatusColor(r.status)
        // Human label: when the run started, not its internal id (that stays in the tooltip).
        const label = relativeTime(r.startedAt) || r.runId.replace(/^run-/, "").slice(0, 8)
        return (
          <button
            key={r.runId}
            type="button"
            onClick={() => onSelect(r.runId)}
            data-testid={`wf-run-${r.runId}`}
            title={`${r.runId} · ${r.status}${r.parked ? " · parked" : ""}`}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[length:var(--text-caption1)] font-[var(--weight-medium)] transition-colors"
            style={{
              background: active ? `color-mix(in srgb, ${color} 20%, transparent)` : "var(--fill-quaternary)",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              boxShadow: active ? "var(--inset-shine)" : undefined,
            }}
          >
            <span className="size-1.5 rounded-full" style={{ background: color }} />
            <span>{label}</span>
            {r.parked && <Bell className="size-3 text-[var(--system-yellow)]" aria-label="parked" />}
          </button>
        )
      })}
    </div>
  )
}

/* ── The derived "Live" projection (dogfood) ─────────────────────────────────
 * Folded into the Executions lens as the pinned "Live" chip (spec §6) — it is
 * an execution view over derived wave receipts, not a third mode. Owns its
 * wave selector + fetch; renders on the same WorkflowGraph canvas. */

function WaveSelector({ runs, selected, onSelect }: { runs: WorkflowRunView[]; selected: number | null; onSelect: (w: number) => void }) {
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

export function LiveProjectionView({ workflowId }: { workflowId: string }) {
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
        <WaveSelector runs={data.runs} selected={selectedWave} onSelect={selectRun} />
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

function StepStateRow({ receipt }: { receipt: RunStepReceiptWire }) {
  // v1 walk statuses + the reserved GRS-014b step-machine states (GRS-014a: display
  // vocabulary lands with the schema; the gateway emits them from 014b).
  const map: Record<string, { icon: typeof CheckCircle2; color: string; label: string; spin?: boolean }> = {
    spawned: { icon: Loader2, color: "var(--system-blue)", label: "Session spawned — running (not yet confirmed complete)", spin: true },
    inline: { icon: CheckCircle2, color: "var(--system-green)", label: "Completed inline (orchestrator)" },
    checkpoint: { icon: CheckCircle2, color: "var(--system-green)", label: "Checkpoint passed (auto-evaluated)" },
    error: { icon: AlertCircle, color: "var(--system-red)", label: "Errored" },
    pending: { icon: Clock, color: "var(--text-tertiary)", label: "Pending — not yet dispatched" },
    dispatching: { icon: Loader2, color: "var(--system-blue)", label: "Dispatching — spawning the step session", spin: true },
    running: { icon: Loader2, color: "var(--system-blue)", label: "Session running (not yet confirmed complete)", spin: true },
    done: { icon: CheckCircle2, color: "var(--system-green)", label: "Completed — session settled" },
    failed: { icon: AlertCircle, color: "var(--system-red)", label: "Failed" },
    skipped: { icon: X, color: "var(--text-tertiary)", label: "Skipped (optional step or branch not taken)" },
    routed: { icon: CheckCircle2, color: "var(--system-green)", label: "Routed — branch decision taken (GRS-016c switch)" },
    fired: { icon: ExternalLink, color: "var(--system-orange)", label: "Fired — session spawned, not awaited (output: none); its completion is unknown by design" },
    waiting: { icon: Clock, color: "var(--system-blue)", label: "Waiting — resumes at the stamped deadline (readyAt)", spin: false },
  }
  const s = map[receipt.status] ?? { icon: CheckCircle2, color: "var(--text-tertiary)", label: receipt.status }
  const Icon = s.icon
  return (
    <div className="flex items-start gap-2 text-[length:var(--text-caption1)]">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${s.spin ? "animate-spin" : ""}`} style={{ color: s.color }} />
      <span className="text-[var(--text-secondary)]">{s.label}</span>
    </div>
  )
}

/* Run-aware inspector. Reads the raw run so it can show spawn state, the session
 * link, and the parked gate's awaited approval — none of which live on CanvasNode. */
export function RunNodeInspector({
  run,
  node,
  onClose,
  onResolveGate,
}: {
  run: WorkflowRunWire
  node: CanvasNode
  onClose: () => void
  /** GRS-014e: resolve the parked gate (approve/reject). Provided by the container,
   * which calls the resolve-gate API and refreshes. Absent → read-only doorbell. */
  onResolveGate?: (decision: "approve" | "reject") => Promise<void>
}) {
  const [resolving, setResolving] = useState<"approve" | "reject" | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const resolve = async (decision: "approve" | "reject") => {
    if (!onResolveGate || resolving) return
    setResolving(decision)
    setResolveError(null)
    try {
      await onResolveGate(decision)
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : "Failed to resolve gate")
    } finally {
      setResolving(null)
    }
  }
  // Latest round's receipt (loop rounds duplicate nodeIds — GRS-014e).
  const receipt = node.kind === "step" ? [...run.steps].reverse().find((s) => s.nodeId === node.id) : undefined
  const isParked = node.status === "parked"
  // The frozen definition node — the calm Setup rows (engine, session mode,
  // error lane; GRS-016b/e config absorbed from the 016f inspector scope).
  const defNode = run.definitionSnapshot?.nodes.find((n) => n.id === node.id)
  return (
    <div data-testid="wf-run-inspector" className="flex h-full flex-col bg-[var(--bg-secondary)]">
      <div className="flex items-start justify-between gap-2 p-[var(--space-4)] pb-[var(--space-2)]">
        <div className="flex min-w-0 items-center gap-3">
          <InspectorStateCircle node={node} />
          <div className="min-w-0">
            <h2 className="truncate text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {node.title}
            </h2>
            <div className="mt-0.5 truncate text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              {/* A parked gate's who ("awaiting human approval") repeats the
               * status line — one calm phrase is enough in the header. */}
              {isParked ? <span>{nodeStatusLine(node)}</span> : <><span>{nodeStatusLine(node)}</span> · <span>{node.who}</span></>}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-[var(--space-4)] pt-[var(--space-3)]" data-scrollable>
        {/* Parked gate — the accountability doorbell. */}
        {isParked && run.parked && (
          <div className="space-y-3">
            <div className="text-[length:var(--text-subheadline)] leading-normal text-[var(--text-primary)]">
              This run is paused, awaiting <span className="font-[var(--weight-semibold)]">human approval</span>.
            </div>
            <div>
              <div className="mb-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                Waiting on
              </div>
              <div className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{run.parked.description}</div>
            </div>
            {onResolveGate ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="wf-gate-approve"
                    disabled={resolving !== null}
                    onClick={() => void resolve("approve")}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-transform hover:scale-[0.98] disabled:opacity-50"
                  >
                    {resolving === "approve" ? "Approving…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    data-testid="wf-gate-reject"
                    disabled={resolving !== null}
                    onClick={() => void resolve("reject")}
                    className="h-9 rounded-full px-4 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--system-red)] transition-colors hover:bg-[color-mix(in_srgb,var(--system-red)_10%,transparent)] disabled:opacity-50"
                  >
                    {resolving === "reject" ? "Rejecting…" : "Reject"}
                  </button>
                </div>
                {resolveError && (
                  <div data-testid="wf-gate-resolve-error" className="text-[length:var(--text-caption1)] text-[var(--system-red)]">
                    {resolveError}
                  </div>
                )}
                <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  Approve resumes the run; reject fails it. This is the only way a parked run moves.
                </div>
              </div>
            ) : (
              <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                Resolve via the run API (POST …/runs/:runId/resolve-gate).
              </div>
            )}
          </div>
        )}

        {/* Setup — the node's frozen config as calm value rows (GRS-016b/c/d/e). */}
        {defNode && <SetupRows node={defNode} />}

        {/* Step receipt — honest spawn state + the real session link. */}
        {receipt && (
          <div className="space-y-3">
            <StepStateRow receipt={receipt} />
            {receipt.detail && !isParked && (
              <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">{receipt.detail}</div>
            )}

            {/* Persisted handoff outcome (GRS-014c) — the evidence the next step was prompted with. */}
            {receipt.outcome && (
              <div data-testid="wf-run-outcome">
                <div className="mb-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
                  Handoff {receipt.outcome.extractedFrom === "handoff-block" ? "(declared)" : "(from final message)"}
                </div>
                {receipt.outcome.summary && (
                  <div className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{receipt.outcome.summary}</div>
                )}
                {receipt.outcome.artifacts && receipt.outcome.artifacts.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {receipt.outcome.artifacts.map((a) => (
                      <li key={a} className="break-all font-mono text-[11px] text-[var(--text-secondary)]">{a}</li>
                    ))}
                  </ul>
                )}
                {receipt.outcome.notes && (
                  <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{receipt.outcome.notes}</div>
                )}
                {/* Declared fields (GRS-016c) — the scalars switch conditions route on. */}
                {receipt.outcome.fields && Object.keys(receipt.outcome.fields).length > 0 && (
                  <div data-testid="wf-run-fields" className="mt-1.5 space-y-0.5">
                    {Object.entries(receipt.outcome.fields).map(([k, v]) => (
                      <div key={k} className="font-mono text-[11px] text-[var(--text-secondary)]">
                        {k}: <span className="text-[var(--text-primary)]">{JSON.stringify(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Frozen routing decision (GRS-016c switch receipts). */}
            {receipt.route && (
              <div data-testid="wf-run-route">
                <div className="mb-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
                  Route taken
                </div>
                <div className="font-mono text-[11px] text-[var(--text-secondary)]">
                  {receipt.route.length > 0 ? receipt.route.join(', ') : '(no branch — nothing matched)'}
                </div>
              </div>
            )}
            {receipt.sessionId && (
              <a
                href={sessionHref(receipt.sessionId)}
                data-testid="wf-run-session-link"
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]"
                style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
              >
                Open session
                <ExternalLink className="size-3.5 shrink-0" />
              </a>
            )}
          </div>
        )}

        {/* Trigger. */}
        {node.kind === "trigger" && (
          <div>
            <div className="mb-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
              Fired
            </div>
            <div className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{node.detail}</div>
            <div className="mt-1 flex items-start gap-1.5 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
              <Clock className="mt-0.5 size-3 shrink-0" />
              <span>{run.startedAt}</span>
            </div>
          </div>
        )}

        {/* Everything internal (ids, refs, timestamps) folds behind one calm
         * disclosure — reachable, never ambient (GRS-019 / 016f). */}
        {(receipt || (isParked && run.parked)) && (
          <details data-testid="wf-run-technical" className="group rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)]">
            <summary className="flex min-h-[46px] cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="block text-[length:var(--text-subheadline)] text-[var(--text-primary)]">Technical details</span>
                <span className="block text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">Session ID, receipt, timestamps</span>
              </span>
              <span className="text-[var(--text-quaternary)] transition-transform group-open:rotate-90" aria-hidden>›</span>
            </summary>
            <div className="space-y-1.5 px-3.5 pb-3 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
              {receipt?.sessionId && <div className="break-all font-mono text-[11px]">session: {receipt.sessionId}</div>}
              {receipt?.attempt !== undefined && <div className="font-mono text-[11px]">attempt: {receipt.attempt}</div>}
              {receipt?.at && <div className="font-mono text-[11px]">at: {receipt.at}</div>}
              {receipt?.dispatchedAt && <div className="font-mono text-[11px]">dispatched: {receipt.dispatchedAt}</div>}
              {receipt?.settledAt && <div className="font-mono text-[11px]">settled: {receipt.settledAt}</div>}
              {isParked && run.parked && (
                <>
                  <div className="font-mono text-[11px]">
                    {run.parked.scope === "runGate" ? "workflow run gate" : "gate node"} · evaluator {run.parked.evaluator}
                  </div>
                  {run.parked.ref && <div className="break-all font-mono text-[11px]">ref: {run.parked.ref}</div>}
                </>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

/* ── Setup rows — the node's frozen definition config as a calm HIG group ─────
 * "Runs on → codex · high", "Session → Fresh per run", "If it fails → Fix
 * lane · 2 attempts". Absorbs the 016f inspector scope (engine options,
 * session-mode, error-lane) without a form dump; the editable form stays in
 * Edit mode. */
const SESSION_LABEL: Record<string, string> = {
  fresh: "Fresh per run",
  workflow: "Shared run session",
  existing: "Existing session",
}
const ON_ERROR_LABEL: Record<string, string> = {
  "fail-run": "Fail the run",
  continue: "Continue",
  "error-edge": "Error lane",
}

function SetupRows({ node }: { node: WorkflowNodeWire }) {
  const rows: { k: string; v: string }[] = []
  if (node.actor) {
    const engine = [node.actor.ref, node.options?.model, node.options?.effort].filter(Boolean).join(" · ")
    rows.push({ k: "Runs on", v: engine })
  }
  if (node.type === "step") {
    rows.push({ k: "Session", v: SESSION_LABEL[node.options?.session?.mode ?? "fresh"] ?? "Fresh per run" })
  }
  if (node.options?.output === "none") rows.push({ k: "Output", v: "Fire and forget" })
  const onError = node.options?.onError
  const retry = node.options?.retry
  if (onError || retry) {
    const v = [
      onError ? ON_ERROR_LABEL[onError] ?? onError : undefined,
      retry ? `${retry.maxAttempts} attempts` : undefined,
      node.options?.timeoutMinutes ? `${node.options.timeoutMinutes}m timeout` : undefined,
    ].filter(Boolean).join(" · ")
    rows.push({ k: "If it fails", v })
  }
  if (node.cadence) rows.push({ k: "Cadence", v: node.cadence })
  if (rows.length === 0 && !node.instructions) return null
  return (
    <div data-testid="wf-run-setup">
      {node.instructions && (
        <div className="mb-3">
          <div className="mb-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
            What it does
          </div>
          <div className="text-[length:var(--text-subheadline)] leading-normal text-[var(--text-secondary)]">{node.instructions}</div>
        </div>
      )}
      {rows.length > 0 && (
        <>
          <div className="mb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
            Setup
          </div>
          <div className="overflow-hidden rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)]">
            {rows.map((r, i) => (
              <div
                key={r.k}
                className="flex min-h-[44px] items-center gap-3 px-3.5 py-2.5"
                style={i > 0 ? { borderTop: "0.5px solid var(--separator)" } : undefined}
              >
                <span className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{r.k}</span>
                <span className="ml-auto text-right text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">{r.v}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* Container: fetch the definition's runs, default to the newest (the parked run),
 * render it on the canvas with the run-aware inspector. The Executions lens:
 * when the gateway serves a derived projection, "Live" rides the same strip as
 * a pinned chip and replays on the same canvas — no third mode. */
export function DefinitionRunView({
  workflowId,
  liveAvailable = false,
  initialLive = false,
}: {
  workflowId: string
  liveAvailable?: boolean
  /** Deep link (?mode=live): open with the pinned Live chip selected. */
  initialLive?: boolean
}) {
  const [showLive, setShowLive] = useState(initialLive)
  const [runs, setRuns] = useState<WorkflowRunSummaryWire[] | null>(null)
  const [evidenceConfigured, setEvidenceConfigured] = useState(true)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [run, setRun] = useState<WorkflowRunWire | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // `error` is the LIST-level failure (loadRuns) — it replaces the whole view.
  // `runError` is scoped to the SELECTED run's fetch: a transient getWorkflowRun
  // failure shows an inline banner but keeps the selector mounted so the user can
  // pick another run to escape it (Lane-4 audit fix).
  const [error, setError] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // Bumped by Refresh so the SELECTED full run re-fetches even when its id is
  // unchanged — a run overwritten in place (running→parked) would otherwise stay
  // stale because the fetch effect only keys on selectedRunId (Codex R1 Major).
  const [refreshKey, setRefreshKey] = useState(0)

  const loadRuns = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .listWorkflowRuns(workflowId)
      .then((r) => {
        setEvidenceConfigured(r.evidenceConfigured)
        setRuns(r.runs)
        // Default-select the newest run (index 0) unless the current selection is still present.
        setSelectedRunId((prev) => (prev && r.runs.some((x) => x.runId === prev) ? prev : r.runs[0]?.runId ?? null))
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load runs"))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [workflowId])

  const refresh = useCallback(() => {
    loadRuns()
    setRefreshKey((k) => k + 1)
  }, [loadRuns])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  // Load the full run whenever the selection (or refreshKey) changes. Clearing
  // `run` first means a stale run is never attributed to a newly-selected id
  // during fetch latency (Codex R1 Minor). try/catch/finally so a transport
  // reject never wedges the view (Codex GRS-011c pattern).
  useEffect(() => {
    setRunError(null)
    if (!selectedRunId) {
      setRun(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const r = await api.getWorkflowRun(workflowId, selectedRunId)
        if (!cancelled) setRun(r)
      } catch (e) {
        // Scoped to the run, NOT the whole view: keep the selector mounted so a
        // transient failure on one run is escapable by picking another.
        if (!cancelled) setRunError(e instanceof Error ? e.message : "Failed to load run")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workflowId, selectedRunId, refreshKey])

  const selectRun = useCallback((runId: string) => {
    setShowLive(false)
    setSelectedRunId(runId)
    setSelectedNodeId(null)
    setRunError(null)
    if (runId === selectedRunId) setRefreshKey((k) => k + 1)
  }, [selectedRunId])

  // A derived-only workflow (no definition runs yet) opens on its Live chip.
  useEffect(() => {
    if (liveAvailable && runs && runs.length === 0) setShowLive(true)
  }, [liveAvailable, runs])

  // GRS-014e: resolve the selected (parked) run's gate, then re-fetch — the returned
  // snapshot is applied immediately so the doorbell clears without waiting a refresh.
  const resolveGate = useCallback(
    async (decision: "approve" | "reject") => {
      if (!selectedRunId) return
      const updated = await api.resolveWorkflowRunGate(workflowId, selectedRunId, decision)
      setRun(updated)
      loadRuns()
    },
    [workflowId, selectedRunId, loadRuns],
  )

  // Only render the full run when it matches the current selection — belt-and-
  // suspenders against a fetch for a previous selection landing late.
  const activeRun = run && run.runId === selectedRunId ? run : null
  const nodes: CanvasNode[] = useMemo(() => (activeRun ? nodesForDefinitionRun(activeRun) : []), [activeRun])
  const graphEdges = useMemo(() => (activeRun ? edgesForDefinitionRun(activeRun, nodes) : []), [activeRun, nodes])
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null

  if (loading) {
    return <div className="flex h-40 items-center justify-center text-[var(--text-tertiary)]">Loading runs…</div>
  }

  return (
    <div className="flex h-full w-full flex-col">
      {error && (
        <div className="m-[var(--space-4)] rounded-[var(--radius-md)] border border-[var(--system-red)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
          {error}
        </div>
      )}

      {!error && !evidenceConfigured && (
        <div className="m-[var(--space-4)] rounded-[var(--radius-md)] border border-[var(--separator)] p-4 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
          Workflow storage is misconfigured on the gateway, so it stores no runs. Check the gateway logs (or the <code>JINN_WORKFLOW_EVIDENCE_ROOT</code> override, if set).
        </div>
      )}

      {!error && evidenceConfigured && runs && runs.length === 0 && !liveAvailable && (
        <div className="m-[var(--space-4)] rounded-[var(--radius-md)] border border-[var(--separator)] p-4 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
          No runs yet. Start one with <code>POST /api/workflow-definitions/{workflowId}/run</code>.
        </div>
      )}

      {!error && runs && (runs.length > 0 || liveAvailable) && (
        <>
          {/* Quiet run strip: selector chips + status, no duplicated title
           * (the page header names the workflow), no receipt jargon. */}
          <div className="flex items-center gap-2 px-5 pb-1 pt-1">
            <DefinitionRunSelector
              runs={runs}
              selected={showLive ? null : selectedRunId}
              onSelect={selectRun}
              liveAvailable={liveAvailable}
              liveSelected={showLive}
              onSelectLive={() => { setShowLive(true); setSelectedNodeId(null) }}
            />
            {!showLive && activeRun && <RunStatusPill status={activeRun.status} />}
            {!showLive && (
              <button
                onClick={refresh}
                disabled={refreshing}
                aria-label="Refresh"
                className="ml-auto grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
              >
                <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />
              </button>
            )}
          </div>

          {showLive && (
            <div className="min-h-0 flex-1">
              <LiveProjectionView workflowId={workflowId} />
            </div>
          )}

          {!showLive && runError && (
            <div
              data-testid="wf-run-fetch-error"
              role="alert"
              className="mx-[var(--space-4)] mt-[var(--space-3)] rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--system-red)_45%,transparent)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] p-3 text-[length:var(--text-caption1)] text-[var(--system-red)]"
            >
              Couldn’t load this run: {runError}. Pick another run or retry.
            </div>
          )}

          {!showLive && activeRun?.status === "failed" && activeRun.errors && activeRun.errors.length > 0 && (
            <div className="mx-[var(--space-4)] mt-[var(--space-3)] rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--system-red)_45%,transparent)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] p-3 text-[length:var(--text-caption1)] text-[var(--system-red)]">
              Run failed: {activeRun.errors.map((e) => e.message).join("; ")}
            </div>
          )}

          {/* GRS-014a interim branching guard — loud, not silent: this run's definition
           * has edges implying a different order than the declaration order it walked. */}
          {!showLive && activeRun?.orderWarning && (
            <div
              data-testid="wf-run-order-warning"
              className="mx-[var(--space-4)] mt-[var(--space-3)] rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--system-yellow)_45%,transparent)] bg-[color-mix(in_srgb,var(--system-yellow)_10%,transparent)] p-3 text-[length:var(--text-caption1)] text-[var(--text-primary)]"
            >
              <span className="font-[var(--weight-semibold)]">Order warning:</span> {activeRun.orderWarning.message}
              {activeRun.orderWarning.impliedOrder && (
                <span className="text-[var(--text-secondary)]"> Edge-implied order: {activeRun.orderWarning.impliedOrder.join(" → ")}.</span>
              )}
            </div>
          )}

          {!showLive && (
            <div className="relative flex min-h-0 flex-1">
              <div className="min-h-0 min-w-0 flex-1">
                {nodes.length > 0 ? (
                  <WorkflowGraph nodes={nodes} selectedId={selectedNodeId} onSelect={setSelectedNodeId} edges={graphEdges} />
                ) : (
                  <div className="flex h-40 items-center justify-center text-[var(--text-tertiary)]">No run selected.</div>
                )}
              </div>

              {selectedNode && activeRun && (
                <InspectorPanel>
                  <RunNodeInspector run={activeRun} node={selectedNode} onClose={() => setSelectedNodeId(null)} onResolveGate={resolveGate} />
                </InspectorPanel>
              )}

              {selectedNode && activeRun && (
                <InspectorSheet onClose={() => setSelectedNodeId(null)}>
                  <RunNodeInspector run={activeRun} node={selectedNode} onClose={() => setSelectedNodeId(null)} onResolveGate={resolveGate} />
                </InspectorSheet>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
