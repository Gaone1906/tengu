import { Handle, Position, type Node as FlowNode, type NodeProps } from "@xyflow/react"
import {
  Clock, Zap, Sparkles, User, ShieldCheck, Diamond, Shuffle,
  Split as SplitIcon, Merge as MergeIcon, AlertTriangle, Hourglass,
  FileText, Wrench, Plus,
} from "lucide-react"
import { AvatarPreview } from "@/components/ui/employee-avatar"
import {
  nodeStatusColor, visualNodeType, dockFraction, condPortTop,
  type CanvasNode, type VisualNodeType,
} from "./canvas-model"
import { nodeStatusLine } from "./status-line"

/* GRS-019c — the per-type node components on the ONE spatial canvas.
 *
 * Size + shape carry meaning (the operator's headline): a compact Trigger pill,
 * standard Employee/Engine cards, the WIDE AI node with engine·model + task
 * summary + MODEL/EMPLOYEE/TOOLS sub-node docks, an Approval gate, a Condition
 * that grows with its outputs, tiny Split/Merge glyphs, attachable Sub-node
 * discs, and Error/Wait treatments. Ledger skin only (globals.css tokens):
 * soft fills + shadow + radius, NO rest hairlines, colour lives on the type
 * icon + the one status dot. Theme-aware by construction (all tokens).
 *
 * Port discipline (the geometry spec, normative): data flows strictly left →
 * right. Every node exposes ONE input port centered on its left wall and its
 * output port(s) centered on its right wall — a condition gets one output per
 * row at that row's center-line, a wide node's dock ports sit on its bottom
 * wall. Ports are VISIBLE 8px dots with a 2px bg halo (a socket, not a
 * blemish); they belong to the card element, never to a padded inner row, so
 * their anchors sit exactly on the wall. The retired 8-anchor set picked walls
 * per-edge by dominant axis — direction stopped meaning anything.
 *
 * The card contract the tests + inspectors depend on is preserved on every
 * INTERACTIVE type: data-testid=`wf-node-<id>`, aria-pressed, data-current,
 * click → onSelect. Sub/split/merge/ghost are non-interactive decoration. */

export interface JinnNodeData extends Record<string, unknown> {
  node: CanvasNode
  selected: boolean
  onSelect: (id: string) => void
}
type NP = NodeProps<FlowNode<JinnNodeData>>

/* ── tints ─────────────────────────────────────────────────────────────────
 * The tinted icon square carries type identity (quieter than a fully-coloured
 * card). Value expressions mirror the approved mock, all theme-aware tokens. */
const TINT: Record<string, { bg: string; fg: string }> = {
  trigger: { bg: "var(--accent-fill)", fg: "var(--accent)" },
  engine: { bg: "color-mix(in srgb, var(--system-purple) 16%, transparent)", fg: "var(--system-purple)" },
  employee: { bg: "color-mix(in srgb, var(--system-blue) 17%, transparent)", fg: "var(--system-blue)" },
  gate: { bg: "color-mix(in srgb, var(--system-orange) 15%, transparent)", fg: "var(--system-orange)" },
  cond: { bg: "color-mix(in srgb, var(--system-blue) 15%, transparent)", fg: "var(--system-blue)" },
  error: { bg: "color-mix(in srgb, var(--system-red) 13%, transparent)", fg: "var(--system-red)" },
  wait: { bg: "color-mix(in srgb, var(--system-orange) 15%, transparent)", fg: "var(--system-orange)" },
  flow: { bg: "var(--fill-secondary)", fg: "var(--text-tertiary)" },
}
const SUB_TINT: Record<string, string> = {
  model: "var(--system-purple)",
  employee: "var(--system-blue)",
  tool: "var(--text-secondary)",
}

function typeIcon(node: CanvasNode, t: VisualNodeType) {
  const cls = "size-[21px]"
  switch (t) {
    case "trigger": return (node.role === "trigger" && node.detail?.includes("manual")) || node.who === "manual"
      ? <Zap className="size-[17px]" /> : <Clock className="size-[17px]" />
    case "employee": return <User className={cls} />
    case "engine": return <Sparkles className={cls} />
    case "wide": return <Sparkles className="size-[23px]" />
    case "gate": return <ShieldCheck className={cls} />
    case "cond": return (node.outputs?.length ?? 2) > 2 ? <Shuffle className="size-[19px]" /> : <Diamond className="size-[19px]" />
    case "error": return <AlertTriangle className={cls} />
    case "wait": return <Hourglass className={cls} />
    default: return <Sparkles className={cls} />
  }
}

/* ── visible ports (spec §2.3) ─────────────────────────────────────────────── */

type PortTone = "true" | "false" | "neutral"

function portFill(tone?: PortTone): string {
  if (tone === "true") return "color-mix(in srgb, var(--system-green) 70%, var(--separator-opaque))"
  if (tone === "false") return "color-mix(in srgb, var(--system-red) 70%, var(--separator-opaque))"
  return "var(--separator-opaque)"
}

/** 8px dot centered ON the wall; the 2px bg-ring halo lifts it off the card
 * and the dots grid (a shadow, not a hairline). Non-connectable in this phase;
 * the 24px touch hit-area lives on .jinn-port in globals.css. */
const PORT_BASE: React.CSSProperties = {
  width: 8, height: 8, minWidth: 8, minHeight: 8,
  border: "none", borderRadius: 999,
  boxShadow: "0 0 0 2px var(--bg)",
  pointerEvents: "none",
}

/** The one input port: left wall, vertical center. */
function InPort() {
  return (
    <Handle
      type="target" position={Position.Left} id="in" isConnectable={false}
      className="jinn-port"
      style={{ ...PORT_BASE, background: portFill(), left: 0, top: "50%", transform: "translate(-50%, -50%)" }}
    />
  )
}

/** An output port on the right wall. Single-output nodes anchor at 50%; a
 * condition names one per output row at that row's center-line. */
function OutPort({ id = "out", top = "50%", tone }: { id?: string; top?: string; tone?: PortTone }) {
  return (
    <Handle
      type="source" position={Position.Right} id={id} isConnectable={false}
      className="jinn-port"
      style={{ ...PORT_BASE, background: portFill(tone), left: "auto", right: 0, top, transform: "translate(50%, -50%)" }}
    />
  )
}

/** A wide node's underside dock port, one per attachable, at its disc's x. */
function DockPort({ i, total }: { i: number; total: number }) {
  return (
    <Handle
      type="source" position={Position.Bottom} id={`d${i}`} isConnectable={false}
      className="jinn-port"
      style={{ ...PORT_BASE, background: portFill(), left: `${dockFraction(i, total) * 100}%`, top: "auto", bottom: 0, transform: "translate(-50%, 50%)" }}
    />
  )
}

/** The sub-disc's single target port: top wall, horizontal center (the dashed
 * dock wire arrives from above). */
function TopInPort() {
  return (
    <Handle
      type="target" position={Position.Top} id="in" isConnectable={false}
      className="jinn-port"
      style={{ ...PORT_BASE, background: portFill(), top: 0, left: "50%", transform: "translate(-50%, -50%)" }}
    />
  )
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

/** Colour + presence of the one status dot/line. Idle/queued reads muted. */
function StatusLine({ node, className = "" }: { node: CanvasNode; className?: string }) {
  const color = nodeStatusColor(node.status)
  const text = node.statusText ?? nodeStatusLine(node)
  return (
    <span className={`mt-1 inline-flex items-center gap-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] ${className}`} style={{ color }}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{text}</span>
    </span>
  )
}

/** Node card box-shadow: rest card, plus a state ring (selected / running /
 * failed / waiting / current) — the calm eye-draw the mock uses, never a rest
 * hairline. */
function cardShadow(node: CanvasNode, selected: boolean): string {
  if (selected) return "var(--shadow-card), 0 0 0 2px color-mix(in srgb, var(--accent) 50%, transparent)"
  if (node.status === "running" || node.status === "active") return "var(--shadow-card), 0 0 0 1.5px color-mix(in srgb, var(--system-blue) 55%, transparent)"
  if (node.status === "blocked") return "var(--shadow-card), 0 0 0 1.5px color-mix(in srgb, var(--system-red) 55%, transparent)"
  if (node.status === "parked") return "var(--shadow-card), 0 0 0 1.5px color-mix(in srgb, var(--system-yellow) 55%, transparent)"
  if (node.isCurrent) return "var(--shadow-card), 0 0 0 3px var(--accent-fill)"
  return "var(--shadow-card)"
}

/** A genuinely-failed card gets a quiet red wash under its ring — the
 * operator's failed=red, kept calm (6% mix, theme-aware). */
function cardBg(node: CanvasNode): string {
  return node.status === "blocked"
    ? "color-mix(in srgb, var(--system-red) 6%, var(--bg-secondary))"
    : "var(--bg-secondary)"
}

const isDim = (node: CanvasNode) => node.status === "idle" || node.status === "cancelled"

interface InnerProps { node: CanvasNode; selected: boolean; onSelect: (id: string) => void }

/** Wrap an interactive node with the shared card contract (testid/aria/click). */
function nodeButtonProps(node: CanvasNode, selected: boolean, onSelect: (id: string) => void) {
  return {
    type: "button" as const,
    onClick: () => onSelect(node.id),
    "data-node-id": node.id,
    "data-testid": `wf-node-${node.id}`,
    "aria-pressed": selected,
    "data-current": node.isCurrent || undefined,
  }
}

/** The shared-language attribution rule: an employee actor renders as the
 * emoji EmployeeChip avatar (emoji on a --fill-secondary circle) — the same
 * unit as chat/Todos. Engines keep the tinted glyph tile. */
function ActorTile({ node, t, size }: { node: CanvasNode; t: VisualNodeType; size: number }) {
  const employee = node.actorKind === "employee" && node.actorRef
  if (employee) {
    return (
      <AvatarPreview
        name={node.actorRef!}
        size={size}
        fontSize={Math.round(size * 0.5)}
        className="shrink-0 bg-[var(--fill-secondary)]"
      />
    )
  }
  const tint = TINT[t] ?? TINT.engine
  return (
    <span
      className="grid shrink-0 place-items-center"
      style={{ width: size, height: size, borderRadius: size >= 40 ? 11 : 10, background: tint.bg, color: tint.fg }}
      aria-hidden
    >
      {typeIcon(node, t)}
    </span>
  )
}

/* ── standard card (employee / engine / error / wait) — 220×64 ────────────── */
function StandardNode({ node, selected, onSelect, t }: InnerProps & { t: VisualNodeType }) {
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full items-center gap-3 rounded-[var(--radius-lg)] px-3.5 text-left transition-[box-shadow,transform] duration-200"
      style={{ background: cardBg(node), boxShadow: cardShadow(node, selected), opacity: isDim(node) ? 0.55 : 1 }}
    >
      <ActorTile node={node} t={t} size={38} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] leading-tight text-[var(--text-primary)]" title={node.title}>
          {node.title}
        </span>
        <StatusLine node={node} />
      </span>
    </button>
  )
}

/* ── trigger pill — 188×56, output port only ──────────────────────────────── */
function TriggerNode({ node, selected, onSelect }: InnerProps) {
  const tint = TINT.trigger
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full items-center gap-2.5 rounded-full py-0 pl-2.5 pr-4 text-left transition-[box-shadow] duration-200"
      style={{ background: "var(--bg-secondary)", boxShadow: cardShadow(node, selected) }}
    >
      <span className="grid size-[34px] shrink-0 place-items-center rounded-full" style={{ background: tint.bg, color: tint.fg }} aria-hidden>
        {typeIcon(node, "trigger")}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--text-footnote)] font-[var(--weight-semibold)] leading-tight text-[var(--text-primary)]" title={node.cadence ?? node.title}>
          {node.cadence ?? node.title}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[length:var(--text-caption2)] font-[var(--weight-medium)]" style={{ color: "var(--accent)" }}>
          <span className="size-1.5 rounded-full" style={{ background: "var(--accent)" }} />Trigger
        </span>
      </span>
    </button>
  )
}

/* ── approval gate — 232×72 ───────────────────────────────────────────────── */
function GateNode({ node, selected, onSelect }: InnerProps) {
  const tint = TINT.gate
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full items-center gap-3 rounded-[var(--radius-lg)] px-3.5 text-left transition-[box-shadow] duration-200"
      style={{ background: cardBg(node), boxShadow: cardShadow(node, selected) }}
    >
      <span className="grid size-[38px] shrink-0 place-items-center rounded-[10px]" style={{ background: tint.bg, color: tint.fg }} aria-hidden>
        {typeIcon(node, "gate")}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] leading-tight text-[var(--text-primary)]" title={node.title}>
          {node.title}
        </span>
        <StatusLine node={node} />
      </span>
    </button>
  )
}

/* ── WIDE AI / engine node — fixed 300×118 / 300×148 with docks ───────────── */
function WideNode({ node, selected, onSelect }: InnerProps) {
  const docks = node.subNodes ?? []
  const engineLabel = node.model
    ? `${node.actorRef ?? (node.actorKind === "engine" ? "Engine" : "Claude")} · ${node.model}`
    : node.actorRef ?? "Engine"
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full flex-col rounded-[var(--radius-xl)] px-4 py-3.5 text-left transition-[box-shadow] duration-200"
      style={{ background: cardBg(node), boxShadow: cardShadow(node, selected), opacity: isDim(node) ? 0.55 : 1 }}
    >
      <span className="flex items-center gap-3">
        <ActorTile node={node} t="wide" size={40} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[length:var(--text-body)] font-[var(--weight-semibold)] leading-tight text-[var(--text-primary)]" title={node.title}>
            {node.title}
          </span>
          <span className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-[8px] px-2 py-0.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)]" style={{ background: "var(--fill-tertiary)", color: "var(--text-secondary)" }}>
            <span className="size-[5px] rounded-full" style={{ background: "var(--system-purple)" }} />{engineLabel}
          </span>
        </span>
      </span>
      {/* Fixed 2-line clamp — the box never grows with prose; the inspector has it all. */}
      {node.summary && (
        <span className="mt-2 line-clamp-2 text-[length:var(--text-caption1)] leading-snug text-[var(--text-secondary)]">{node.summary}</span>
      )}
      <span className="mt-auto flex items-center justify-between gap-2 pt-2">
        <span className="flex gap-1.5">
          {docks.map((d) => (
            <span key={d.role} className="rounded-[7px] px-2 py-1 text-[9.5px] font-[var(--weight-semibold)] uppercase tracking-[0.04em]" style={{ background: "var(--fill-tertiary)", color: "var(--text-tertiary)" }}>
              {d.kind}
            </span>
          ))}
        </span>
        <StatusLine node={node} className="mt-0 shrink-0" />
      </span>
    </button>
  )
}

/* ── condition (IF / Switch) — 220×(50 + n×32 + 8), one port per row ──────── */
export const DEFAULT_IF_OUTPUTS = [
  { id: "true", label: "true", tone: "true" as const },
  { id: "false", label: "false", tone: "false" as const },
]

function CondNode({ node, selected, onSelect }: InnerProps) {
  const tint = TINT.cond
  const outs = node.outputs ?? DEFAULT_IF_OUTPUTS
  const isSwitch = outs.length > 2
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full flex-col rounded-[var(--radius-lg)] px-3.5 pt-2 text-left transition-[box-shadow] duration-200"
      style={{ background: cardBg(node), boxShadow: cardShadow(node, selected), opacity: isDim(node) ? 0.55 : 1 }}
    >
      <span className="flex h-[42px] items-center gap-2.5">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px]" style={{ background: tint.bg, color: tint.fg }} aria-hidden>
          {typeIcon(node, "cond")}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] leading-tight text-[var(--text-primary)]" title={node.title}>
            {node.title}
          </span>
          <span className="text-[length:var(--text-caption2)] font-[var(--weight-medium)] text-[var(--text-tertiary)]">
            {isSwitch ? `Switch · ${outs.length} routes` : "IF · condition"}
          </span>
        </span>
      </span>
      {/* Output rows: right-aligned tone capsules on the COND_ROW rhythm. Their
        * port dots are NOT here — they belong to the card wall (dispatcher). */}
      {outs.map((o) => {
        const tone = o.tone ?? "neutral"
        const c = tone === "true" ? "var(--system-green)" : tone === "false" ? "var(--system-red)" : "var(--text-secondary)"
        const bg = tone === "true"
          ? "color-mix(in srgb, var(--system-green) 14%, transparent)"
          : tone === "false"
            ? "color-mix(in srgb, var(--system-red) 13%, transparent)"
            : "var(--fill-tertiary)"
        return (
          <span key={o.id} className="flex h-8 items-center justify-end">
            <span className="max-w-full truncate rounded-[7px] px-2.5 py-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)]" style={{ background: bg, color: c }}>
              {o.label}
            </span>
          </span>
        )
      })}
    </button>
  )
}

/* ── split / merge glyphs — the box IS the 52×52 disc ─────────────────────── */
function MiniGlyphNode({ node, t }: { node: CanvasNode; t: "split" | "merge" }) {
  return (
    <div data-node-id={node.id} className="relative h-full w-full">
      <span className="grid h-full w-full place-items-center rounded-[15px]" style={{ background: "var(--bg-secondary)", boxShadow: "var(--shadow-card)", color: "var(--text-tertiary)" }} aria-hidden>
        {t === "split" ? <SplitIcon className="size-[22px] rotate-90" /> : <MergeIcon className="size-[22px] rotate-90" />}
      </span>
      {/* Caption below the disc — a decoration OUTSIDE the box, out of the wire path. */}
      <span className="pointer-events-none absolute left-1/2 top-full w-[120px] -translate-x-1/2 pt-1.5 text-center text-[10px] font-[var(--weight-semibold)] uppercase tracking-[0.05em] text-[var(--text-tertiary)]">{t}</span>
      <InPort />
      <OutPort />
    </div>
  )
}

/* ── sub-node disc (attachable) — the box IS the 46×46 disc ───────────────── */
function SubNode({ node }: { node: CanvasNode }) {
  const role = node.subRole ?? "tool"
  const Icon = role === "model" ? FileText : role === "employee" ? User : Wrench
  return (
    <div data-node-id={node.id} className="relative h-full w-full">
      <span className="grid h-full w-full place-items-center rounded-full" style={{ background: "var(--bg-secondary)", boxShadow: "var(--shadow-card)", color: SUB_TINT[role] }} aria-hidden>
        {role === "employee" && node.title
          ? <AvatarPreview name={node.title} size={46} fontSize={20} className="bg-transparent" />
          : <Icon className="size-[20px]" />}
      </span>
      {/* Slot label + value stacked BELOW the disc (never above — the dock wire
        * arrives from above and must not pass through text). Outside the box. */}
      <span className="pointer-events-none absolute left-1/2 top-full w-[120px] -translate-x-1/2 pt-2 text-center">
        <span className="block text-[10px] font-[var(--weight-semibold)] uppercase tracking-[0.05em] text-[var(--text-quaternary)]">{node.subKind}</span>
        <span className="block text-[length:var(--text-caption2)] font-[var(--weight-semibold)] leading-tight text-[var(--text-secondary)]">{node.title}</span>
      </span>
      <TopInPort />
    </div>
  )
}

/* ── ghost add-node (empty canvas teaching affordance, spec §7) ───────────── */
function GhostNode() {
  return (
    <div
      aria-hidden
      className="flex h-full w-full items-center justify-center gap-1.5 rounded-[var(--radius-lg)] text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-tertiary)]"
      style={{ border: "2px dashed var(--separator)" }}
    >
      <Plus className="size-4" /> Add step
    </div>
  )
}

/* ── dispatcher ───────────────────────────────────────────────────────────── */
export function JinnNode({ data }: NP) {
  const { node, selected, onSelect } = data
  const t = visualNodeType(node)
  // Disc + decoration types own their ports (disc-wall centers).
  if (t === "split") return <MiniGlyphNode node={node} t="split" />
  if (t === "merge") return <MiniGlyphNode node={node} t="merge" />
  if (t === "sub") return <SubNode node={node} />
  if (t === "ghost") return <GhostNode />

  let inner: React.ReactNode
  switch (t) {
    case "trigger": inner = <TriggerNode node={node} selected={selected} onSelect={onSelect} />; break
    case "wide": inner = <WideNode node={node} selected={selected} onSelect={onSelect} />; break
    case "gate": inner = <GateNode node={node} selected={selected} onSelect={onSelect} />; break
    case "cond": inner = <CondNode node={node} selected={selected} onSelect={onSelect} />; break
    default: inner = <StandardNode node={node} selected={selected} onSelect={onSelect} t={t} />
  }

  // Strict LTR ports, attached to the CARD (the node root), never a padded row:
  // one left input (triggers have none), right output(s) — a condition gets one
  // per output row at condPortTop(i), a wide node adds its underside dock ports.
  const condOuts = t === "cond" ? node.outputs ?? DEFAULT_IF_OUTPUTS : null
  const docks = t === "wide" ? node.subNodes ?? [] : []
  return (
    <div className="relative h-full w-full">
      {inner}
      {t !== "trigger" && <InPort />}
      {condOuts
        ? condOuts.map((o, i) => (
            <OutPort key={o.id} id={`out-${i}`} top={`${condPortTop(i)}px`} tone={o.tone ?? "neutral"} />
          ))
        : <OutPort />}
      {docks.map((_, i) => <DockPort key={i} i={i} total={docks.length} />)}
    </div>
  )
}

export const jinnNodeTypes = { jinn: JinnNode }
