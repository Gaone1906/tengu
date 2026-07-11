import { useEffect, useState } from "react"
import { useReactFlow, useViewport, type Node as FlowNode } from "@xyflow/react"
import { Maximize2, Plus, Minus, Network } from "lucide-react"
import { type CanvasEdgeSpec, type CanvasNode } from "./canvas-model"

/* GRS-019c — canvas chrome + view behaviour (kept out of canvas.tsx so the
 * render surface stays lean). Frosted Ledger controls (fit / zoom / tidy) + a
 * zoom% readout and the "most relevant node" picker the readable focused-view uses.
 * Layout mutation belongs to the gateway-backed editor preview. Pure helpers unit-test without a
 * DOM; the control bar reads the live React Flow store. */

const MOBILE_QUERY = "(max-width: 767px)"

/** Track the narrow breakpoint so the canvas can open focused (not fit-tiny)
 * and size its controls for touch. */
export function useIsCanvasMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(() => window.matchMedia?.(MOBILE_QUERY).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE_QUERY)
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return mobile
}

/** The node the mobile canvas opens focused on: the live doorbell/work first,
 * then the current step, else the first real step (never a dock disc). Pure. */
export function pickFocusNode(nodes: CanvasNode[], activeNodeId?: string | null): CanvasNode | undefined {
  const real = nodes.filter((n) => n.visual !== "sub" && n.visual !== "split" && n.visual !== "merge")
  if (activeNodeId) {
    const picked = real.find((n) => n.id === activeNodeId)
    if (picked) return picked
  }
  return (
    real.find((n) => n.status === "parked") ??
    real.find((n) => n.status === "blocked" || n.status === "failed") ??
    real.find((n) => n.status === "running" || n.status === "active") ??
    real.find((n) => n.isCurrent) ??
    real.find((n) => n.kind !== "trigger") ??
    real[0]
  )
}

/** Decide whether opening on the whole graph would still be readable. Mobile
 * always opens on the most relevant node; desktop fits only above the minimum
 * useful card scale. "Fit all" remains an explicit escape hatch. */
export function initialViewportPlan({
  mobile,
  fitZoom = 1,
  nodes,
  activeNodeId,
}: {
  mobile: boolean
  fitZoom?: number
  nodes: CanvasNode[]
  activeNodeId?: string | null
}): { mode: "focus" | "fit"; nodeId?: string; zoom: number } {
  const focus = pickFocusNode(nodes, activeNodeId)
  if (mobile || fitZoom < 0.65) {
    return {
      mode: "focus",
      ...(focus ? { nodeId: focus.id } : {}),
      zoom: mobile ? 0.9 : 0.8,
    }
  }
  return { mode: "fit", zoom: fitZoom }
}

/** Stable semantic identity for the graph framing. Positions are deliberately
 * excluded so dragging a node never steals the viewport back from the user;
 * topology, run state, and an explicit caller identity do request a reframe. */
export function viewportFrameKey(
  nodes: CanvasNode[],
  edges: CanvasEdgeSpec[] = [],
  viewKey = "",
): string {
  return JSON.stringify({
    viewKey,
    nodes: nodes
      .filter((node) => node.visual !== "sub")
      .map((node) => [node.id, node.kind, node.visual ?? "", node.status, Boolean(node.isCurrent)]),
    edges: edges
      .filter((edge) => edge.lane !== "sub")
      .map((edge) => [edge.id ?? "", edge.from, edge.to, edge.kind ?? "", edge.lane ?? ""]),
  })
}

/** Frosted control cluster: zoom% · fit · zoom in/out and an optional
 * gateway-backed editor Tidy action. Sits bottom-left,
 * inside the ReactFlow provider so it can drive the live viewport. */
export function CanvasControls({
  onTidy,
  mobile = false,
}: {
  onTidy?: () => void
  mobile?: boolean
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const { zoom } = useViewport()
  const btn = mobile ? "size-11" : "size-10"
  const icon = mobile ? "size-[20px]" : "size-[18px]"
  const Btn = ({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) => (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`grid ${btn} place-items-center rounded-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]`}
      style={{ background: "var(--material-regular)", boxShadow: "var(--shadow-overlay)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
    >
      {children}
    </button>
  )
  return (
    <>
      <div
        className="pointer-events-none absolute left-4 z-10 select-none rounded-[8px] px-2.5 py-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]"
        style={{ bottom: mobile ? 64 : 62, background: "var(--material-regular)", boxShadow: "var(--shadow-card)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
        data-testid="wf-zoom"
      >
        {Math.round(zoom * 100)}%
      </div>
      <div className="absolute left-4 bottom-4 z-10 flex gap-1.5">
        <Btn label="Fit all" onClick={() => fitView({ padding: 0.2, duration: 300 })}><Maximize2 className={icon} /></Btn>
        <Btn label="Zoom in" onClick={() => zoomIn({ duration: 200 })}><Plus className={icon} /></Btn>
        <Btn label="Zoom out" onClick={() => zoomOut({ duration: 200 })}><Minus className={icon} /></Btn>
        {onTidy && <Btn label="Tidy" onClick={onTidy}><Network className={icon} /></Btn>}
      </div>
    </>
  )
}

/** Minimap node tint — the run status colour, muted, so the whole-shape overview
 * still reads the failed/running/done beats. */
export function minimapNodeColor(n: FlowNode): string {
  const status = (n.data as { node?: CanvasNode } | undefined)?.node?.status
  switch (status) {
    case "passed":
    case "completed": return "var(--system-green)"
    case "running":
    case "active": return "var(--system-blue)"
    case "blocked": return "var(--system-red)"
    case "parked": return "var(--system-orange)"
    default: return "var(--text-quaternary)"
  }
}
