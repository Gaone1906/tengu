import type { WorkflowGateResult, WorkflowNodePosition, WorkflowNodeWire, WorkflowEdgeWire } from "@/lib/api"

/* GRS-013 — the ONE CanvasNode-builder contract (KISS-audit simplify item 2).
 *
 * Live (derived wave receipts), Runs (executor run records) and Edit (the
 * durable definition) all render the same node shape on the same substrate.
 * Before this slice each view grew its own builder with its own synthetic-node
 * and id-collision rules; now `buildCanvasNodes` owns those rules once and the
 * views keep only a thin wire→seed mapping (their honest status vocabulary).
 *
 * Pure data, no React — unit-tests without a gateway or a DOM. */

/* A canvas node is a synthetic trigger, one workflow step, or a gate. Keeping a
 * single node shape lets the graph render all three views uniformly. */
export interface CanvasNode {
  id: string
  kind: "trigger" | "step" | "gate" | "switch" | "fail" | "wait"
  title: string
  role: string
  who: string
  /** node status for colouring: passed | active | pending | blocked | needs_fix | running | parked | draft … */
  status: string
  isCurrent: boolean
  cadence?: string
  optional?: boolean
  gates: WorkflowGateResult[]
  /** full detail prose for the inspector (never rendered on the canvas) */
  detail?: string
  /** spatial position from the definition, when it carries one (GRS-013 #6) */
  position?: WorkflowNodePosition

  /* ── GRS-019c display fields ──────────────────────────────────────────────
   * Optional, derived by the view adapters from the wire node. They drive the
   * per-type VISUAL (engine·model chip, wide task summary, sub-node docks,
   * switch output ports) without changing the honest status model. Absent =
   * the node renders as a plain standard card, exactly as before. */
  /** actor.kind — an employee teammate (blue person) or an engine (purple sparkle). */
  actorKind?: "employee" | "engine"
  /** actor.ref — the teammate/engine name, shown on the wide node + docks. */
  actorRef?: string
  /** options.model — e.g. "Opus"; the engine·model chip + MODEL dock. */
  model?: string
  /** instructions/task text — its PRESENCE promotes an engine/employee step to the WIDE node. */
  summary?: string
  /** a derived tools label (e.g. "Shell · Tests") — the TOOLS dock, when known. */
  tools?: string
  /** switch/IF output ports, top→bottom. IF = 2 (true/false); Switch = N. */
  outputs?: { id: string; label: string; tone?: "true" | "false" | "neutral" }[]
  /** attachable sub-node discs docked under a WIDE node (GRS-019c, decision 2). */
  subNodes?: CanvasSubNode[]
  /** Force the visual type (fixtures / synthesized split·merge·sub); absent = derived. */
  visual?: VisualNodeType
  /** sub-node identity when this node IS a dock disc (set by expandCanvas). */
  subRole?: "model" | "employee" | "tool"
  /** the SLOT label over a dock disc ("MODEL" / "EMPLOYEE" / "TOOLS"). */
  subKind?: string
  /** richer status line when the adapter/fixture has it ("Done · 3m 40s"); absent
   * = the honest generic phrase from nodeStatusLine(). Never changes the state. */
  statusText?: string
}

/** One attachable under a wide node: a model / employee / tools disc. */
export interface CanvasSubNode {
  role: "model" | "employee" | "tool"
  /** the uppercase slot label — MODEL / EMPLOYEE / TOOLS. */
  kind: string
  /** the value shown under the disc — "Opus", "Jinn Dev", "Shell · Tests". */
  label: string
}

/** A real definition edge to draw (GRS-019): the run's frozen snapshot topology,
 * so branches fan out and reconverge visibly instead of a consecutive chain. */
export interface CanvasEdgeSpec {
  id?: string
  from: string
  to: string
  /** 'error' = the failure lane of an onError:'error-edge' step (dashed red);
   * 'sub' = a dashed diamond dock to a wide node's attachable disc. */
  lane?: string
  /** which underside dock (0-based) a `sub` edge leaves — picks the source handle. */
  dockIndex?: number
  /** which switch/IF output (0-based) this edge leaves — picks the output port. */
  outIndex?: number
  /** run-view item count rendered as a calm pill mid-edge ("1 item"). */
  items?: number
}

/* ── Per-type visual system (GRS-019c) ──────────────────────────────────────
 * Size + shape carry meaning (the operator's headline): a compact trigger, a
 * standard employee/engine, the WIDE AI node, an approval gate, a growing
 * condition, tiny split/merge glyphs, sub-node discs, error/wait treatments.
 * `visualNodeType` maps the honest structural `kind` (+ display fields) to the
 * rendered type; `nodeGeometry` gives each its box. Both pure → unit-tested. */
export type VisualNodeType =
  | "trigger" | "employee" | "engine" | "wide"
  | "gate" | "cond" | "split" | "merge" | "sub" | "error" | "wait"

export function visualNodeType(node: CanvasNode): VisualNodeType {
  if (node.visual) return node.visual
  switch (node.kind) {
    case "trigger": return "trigger"
    case "wait": return "wait"
    case "fail": return "error"
    case "gate": return "gate"
    case "switch": return "cond"
    default: {
      // A step with a written task summary is the WIDE AI/engine node (room for
      // the engine·model chip, the summary, and MODEL/EMPLOYEE/TOOLS docks).
      if (node.summary && node.summary.trim()) return "wide"
      if (node.actorKind === "employee") return "employee"
      return "engine"
    }
  }
}

export function nodeStatusColor(status: string): string {
  switch (status) {
    case "passed": return "var(--system-green)"
    case "active": return "var(--system-blue)"
    // GRS-011d-2c-ui run states. `running` = a step whose session was SPAWNED but is not
    // proven done (blue, distinct from the green "passed" — spawn ≠ done, Fable memo-5 §2.2).
    // `parked` = the run halted on a human-approval gate (yellow doorbell, the accountability
    // beat) — calm and prominent, not an error red.
    case "running": return "var(--system-blue)"
    case "parked": return "var(--system-yellow)"
    case "blocked": return "var(--system-red)"
    case "needs_fix": return "var(--system-orange)"
    // GRS-014a honest run statuses. `completed` = work actually finished (green earned).
    // `dispatched` = the retired v1 walk-terminal served read-time-mapped: sessions were
    // fired, completion UNKNOWN — deliberately grey, never green. `cancelled` = inert grey.
    case "completed": return "var(--system-green)"
    case "dispatched": return "var(--text-tertiary)"
    case "cancelled": return "var(--text-tertiary)"
    default: return "var(--text-tertiary)"
  }
}

/** Return `base` if free, else `base-2`, `base-3`… — and reserve it in `taken`.
 * Synthetic node ids (trigger / run-gate / parked) must never collide with a
 * real, user-editable definition node id, or the inspector's node lookup would
 * resolve the wrong node and React keys/testids would duplicate (Codex R1 Major). */
function freshId(base: string, taken: Set<string>): string {
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  taken.add(id)
  return id
}

/** A view's per-node input to the builder: the honest status mapping stays in
 * the view adapter; structural defaults (kind, gates, isCurrent) live here. */
export interface CanvasNodeSeed {
  id: string
  kind?: "trigger" | "step" | "gate" | "switch" | "fail" | "wait"
  title: string
  role: string
  who: string
  status: string
  isCurrent?: boolean
  cadence?: string
  optional?: boolean
  gates?: WorkflowGateResult[]
  detail?: string
  position?: WorkflowNodePosition
  /* GRS-019c display fields (see CanvasNode) — carried through verbatim. */
  actorKind?: "employee" | "engine"
  actorRef?: string
  model?: string
  summary?: string
  tools?: string
  outputs?: { id: string; label: string; tone?: "true" | "false" | "neutral" }[]
  subNodes?: CanvasSubNode[]
  visual?: VisualNodeType
  subRole?: "model" | "employee" | "tool"
  subKind?: string
  statusText?: string
}

/** Copy the optional GRS-019c display fields from a seed onto a node. */
function copyDisplayFields(seed: CanvasNodeSeed, node: CanvasNode): void {
  if (seed.actorKind !== undefined) node.actorKind = seed.actorKind
  if (seed.actorRef !== undefined) node.actorRef = seed.actorRef
  if (seed.model !== undefined) node.model = seed.model
  if (seed.summary !== undefined) node.summary = seed.summary
  if (seed.tools !== undefined) node.tools = seed.tools
  if (seed.outputs !== undefined) node.outputs = seed.outputs
  if (seed.subNodes !== undefined) node.subNodes = seed.subNodes
  if (seed.visual !== undefined) node.visual = seed.visual
  if (seed.subRole !== undefined) node.subRole = seed.subRole
  if (seed.subKind !== undefined) node.subKind = seed.subKind
  if (seed.statusText !== undefined) node.statusText = seed.statusText
}

export interface CanvasGraphSpec {
  /** Synthetic trigger, prepended with a collision-proof `__trigger__` id.
   * Omit when the definition renders its own real trigger node(s) (Edit). */
  trigger?: Omit<CanvasNodeSeed, "id" | "kind">
  steps: CanvasNodeSeed[]
  /** Synthetic terminal gate (e.g. wave gates), appended with a collision-proof id. */
  terminalGate?: CanvasNodeSeed
  /** A run parked on a human-approval gate: promote the gate's own step node to
   * the doorbell when it has a receipt on the canvas, else append a synthetic
   * gate (v1 records without a gate receipt). */
  parked?: { nodeId: string | null; description: string; position?: WorkflowNodePosition }
}

function seedToNode(seed: CanvasNodeSeed, kind: CanvasNode["kind"]): CanvasNode {
  const node: CanvasNode = {
    id: seed.id,
    kind,
    title: seed.title,
    role: seed.role,
    who: seed.who,
    status: seed.status,
    isCurrent: seed.isCurrent ?? false,
    gates: seed.gates ?? [],
  }
  if (seed.cadence !== undefined) node.cadence = seed.cadence
  if (seed.optional !== undefined) node.optional = seed.optional
  if (seed.detail !== undefined) node.detail = seed.detail
  if (seed.position !== undefined) node.position = seed.position
  copyDisplayFields(seed, node)
  return node
}

/** Build the ordered canvas node list for one view. Owns the synthetic-node and
 * id-uniquification rules shared by Live / Runs / Edit. */
export function buildCanvasNodes(spec: CanvasGraphSpec): CanvasNode[] {
  // Reserve every real step id first, so synthetic ids route around them.
  const taken = new Set<string>(spec.steps.map((s) => s.id))
  const nodes: CanvasNode[] = []
  if (spec.trigger) {
    nodes.push(seedToNode({ ...spec.trigger, id: freshId("__trigger__", taken) }, "trigger"))
  }
  for (const step of spec.steps) nodes.push(seedToNode(step, step.kind ?? "step"))
  if (spec.terminalGate) {
    nodes.push(seedToNode({ ...spec.terminalGate, id: freshId(spec.terminalGate.id, taken) }, "gate"))
  }
  if (spec.parked) {
    // GRS-014b runs materialize a receipt for EVERY node up front (gate nodes included,
    // held at `pending` while parked), so when the parking gate already has a node on
    // the canvas we promote THAT node to the parked doorbell instead of appending a
    // duplicate synthetic one. v1 records (no receipt for the gate) keep the synthetic.
    const existing = spec.parked.nodeId ? nodes.find((n) => n.id === spec.parked!.nodeId) : undefined
    if (existing) {
      existing.status = "parked"
      existing.kind = "gate"
      existing.role = "gate"
      existing.who = "awaiting human approval"
      existing.detail = spec.parked.description
    } else {
      const seed: CanvasNodeSeed = {
        id: freshId(spec.parked.nodeId ?? "__rungate__", taken),
        title: "Approval gate",
        role: "gate",
        who: "awaiting human approval",
        status: "parked",
        detail: spec.parked.description,
      }
      if (spec.parked.position !== undefined) seed.position = spec.parked.position
      nodes.push(seedToNode(seed, "gate"))
    }
  }
  return nodes
}

/* ── Spatial layout ───────────────────────────────────────────────────────────
 * Definitions carry x/y — use them (done-bar #6). Views without positions (the
 * derived Live projection) get a trivial deterministic left-to-right lane by
 * declaration order — no auto-layout engine in this slice. */

/* GRS-019 card geometry: the shared glyph+label+status-line card is wider and
 * shorter than the retired role-chip card. */
export const NODE_W = 220
export const NODE_H = 64
const LANE_GAP_X = 80
const LANE_GAP_Y = 64
/** Stored positions are honoured only when they're plausibly pixel coordinates:
 * index-like or all-identical positions (old fixtures/migrations) would stack
 * every card on one spot, which is exactly the failure this slice kills. */
const MIN_POSITION_SPREAD = 80

export function resolveNodePositions(nodes: CanvasNode[]): Record<string, WorkflowNodePosition> {
  const out: Record<string, WorkflowNodePosition> = {}
  const positioned = nodes.filter((n) => n.position)
  const xs = positioned.map((n) => n.position!.x)
  const ys = positioned.map((n) => n.position!.y)
  const spreadX = positioned.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0
  const spreadY = positioned.length >= 2 ? Math.max(...ys) - Math.min(...ys) : 0
  const usable = positioned.length >= 2 && (spreadX >= MIN_POSITION_SPREAD || spreadY >= MIN_POSITION_SPREAD)

  if (!usable) {
    // Left-to-right lane by declaration order.
    nodes.forEach((n, i) => {
      out[n.id] = { x: i * (NODE_W + LANE_GAP_X), y: 0 }
    })
    return out
  }

  for (const n of positioned) out[n.id] = n.position!
  // Unpositioned nodes (synthetic trigger/gates) continue the graph past its
  // extreme along the dominant axis, aligned with the last positioned node.
  const vertical = spreadY >= spreadX
  const last = positioned[positioned.length - 1].position!
  let cursor = vertical ? Math.max(...ys) : Math.max(...xs)
  for (const n of nodes) {
    if (out[n.id]) continue
    cursor += vertical ? NODE_H + LANE_GAP_Y : NODE_W + LANE_GAP_X
    out[n.id] = vertical ? { x: last.x, y: cursor } : { x: cursor, y: last.y }
  }
  return out
}

/** Pick the port pair for an edge by the dominant axis between the two laid-out
 * nodes: horizontal flow exits right / enters left, vertical flow exits bottom /
 * enters top — the curve stays visible in the gap instead of hiding behind cards. */
export function edgeAnchors(
  from: WorkflowNodePosition,
  to: WorkflowNodePosition,
): { source: "sr" | "sb" | "sl" | "st"; target: "tl" | "tt" | "tr" | "tb" } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { source: "sr", target: "tl" } : { source: "sl", target: "tr" }
  }
  return dy >= 0 ? { source: "sb", target: "tt" } : { source: "st", target: "tb" }
}

/* ── Per-type geometry (GRS-019c legend spec) ───────────────────────────────
 * Each visual type gets its own box; size carries meaning. The custom node
 * components render at exactly these dimensions so React Flow's handle anchors
 * and the minimap stay in register. Wide/condition heights grow with content. */
export interface NodeBox { w: number; h: number }

const WIDE_W = 300
/** Approx chars per line inside the 300px wide-node summary at 12.5px. */
const WIDE_SUMMARY_CPL = 40

export function nodeGeometry(node: CanvasNode): NodeBox {
  switch (visualNodeType(node)) {
    case "trigger": return { w: 188, h: 58 }
    case "gate": return { w: 232, h: 76 }
    case "wide": {
      const chars = node.summary?.trim().length ?? 0
      const lines = Math.min(3, Math.max(1, Math.ceil(chars / WIDE_SUMMARY_CPL)))
      const hasDocks = (node.subNodes?.length ?? 0) > 0
      // header(52) + summary + slots row(hasDocks?30:0) + paddings(26)
      return { w: WIDE_W, h: 78 + lines * 18 + (hasDocks ? 30 : 0) }
    }
    case "cond": {
      const outs = Math.max(2, node.outputs?.length ?? 2)
      return { w: 210, h: 54 + outs * 30 }
    }
    case "split":
    case "merge": return { w: 60, h: 76 }
    case "sub": return { w: 68, h: 84 }
    // employee / engine / error / wait — the standard card
    default: return { w: 214, h: 66 }
  }
}

/* ── Sub-node dock expansion (GRS-019c decision 2) ──────────────────────────
 * A WIDE node's MODEL / EMPLOYEE / TOOLS attachables render as small discs on
 * its underside, joined by dashed diamond docks. We synthesize them as real
 * (non-interactive) canvas nodes + `sub` edges so the ONE canvas renders them
 * uniformly. Only when the parent carries a pixel position (real defs / runs /
 * fixtures) — the position-less Live lane keeps the attachables inline.
 *
 * Pure: nodes+edges in, augmented nodes+edges out. Idempotent-safe (skips nodes
 * that already carry a subRole). Unit-tested without a DOM. */
const DOCK_GAP_Y = 116
const SUB_W = 68

/** The horizontal fraction (0..1) of a wide node's underside where dock `i` of
 * `total` sits — evenly spread so the disc and its bottom source handle align. */
export function dockFraction(i: number, total: number): number {
  return (i + 1) / (total + 1)
}

/* ── Wire → display fields (GRS-019c) ───────────────────────────────────────
 * Map a definition node (+ its outgoing edges) to the optional per-type display
 * fields, so REAL Runs/Edit graphs render the right visual: an engine·model
 * chip, the WIDE node when the step carries a written task, its MODEL/EMPLOYEE
 * docks, and a switch's stacked output ports. Honest-state untouched — these
 * are display-only. Pure; unit-tested. */
export interface DisplayFields {
  actorKind?: "employee" | "engine"
  actorRef?: string
  model?: string
  summary?: string
  subNodes?: CanvasSubNode[]
  outputs?: { id: string; label: string; tone?: "true" | "false" | "neutral" }[]
}

/** Summarize a switch out-edge into a short human port label. */
function outputLabel(edge: WorkflowEdgeWire, index: number): string {
  if (edge.label && edge.label.trim()) return edge.label.trim()
  if (!edge.when || edge.when.length === 0) return "default"
  const c = edge.when[0]
  const leaf = c.path.split(".").pop() ?? c.path
  return c.value !== undefined ? `${leaf} ${c.op} ${c.value}` : `${leaf} ${c.op}`
}

export function deriveDisplayFields(node: WorkflowNodeWire, outEdges: WorkflowEdgeWire[] = []): DisplayFields {
  const f: DisplayFields = {}
  if (node.actor) { f.actorKind = node.actor.kind; f.actorRef = node.actor.ref }
  if (node.options?.model) f.model = node.options.model
  const task = node.instructions?.trim()
  if (task) f.summary = task
  // A step with a written task is the WIDE node → dock its model + teammate.
  if (task && node.actor) {
    const subs: CanvasSubNode[] = []
    if (node.options?.model) subs.push({ role: "model", kind: "MODEL", label: node.options.model })
    if (node.actor.kind === "employee") subs.push({ role: "employee", kind: "EMPLOYEE", label: node.actor.ref })
    if (subs.length > 0) f.subNodes = subs
  }
  // Switch outputs → stacked ports (skip the error lane; it draws its own).
  if (node.type === "switch") {
    const outs = outEdges.filter((e) => e.lane !== "error")
    if (outs.length > 0) {
      f.outputs = outs.map((e, i) => ({ id: e.id, label: outputLabel(e, i), tone: "neutral" as const }))
    }
  }
  return f
}

export function expandCanvas(
  nodes: CanvasNode[],
  edges?: CanvasEdgeSpec[],
): { nodes: CanvasNode[]; edges: CanvasEdgeSpec[] } {
  const outNodes: CanvasNode[] = [...nodes]
  const outEdges: CanvasEdgeSpec[] = edges ? [...edges] : []
  for (const parent of nodes) {
    const subs = parent.subNodes
    if (!subs || subs.length === 0 || !parent.position) continue
    if (visualNodeType(parent) !== "wide") continue
    const geo = nodeGeometry(parent)
    const total = subs.length
    const y = parent.position.y + geo.h + DOCK_GAP_Y
    subs.forEach((s, i) => {
      const id = `${parent.id}__dock_${s.role}`
      const centerX = parent.position!.x + geo.w * dockFraction(i, total)
      outNodes.push({
        id,
        kind: "step",
        visual: "sub",
        subRole: s.role,
        subKind: s.kind,
        title: s.label,
        role: s.role,
        who: "",
        status: "idle",
        isCurrent: false,
        gates: [],
        position: { x: centerX - SUB_W / 2, y },
      })
      outEdges.push({ id: `${parent.id}->${id}`, from: parent.id, to: id, lane: "sub", dockIndex: i })
    })
  }
  return { nodes: outNodes, edges: outEdges }
}
