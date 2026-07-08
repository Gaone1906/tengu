import { Handle, Position, type Node as FlowNode, type NodeProps } from "@xyflow/react"
import {
  Clock, Zap, Sparkles, User, ShieldCheck, Diamond, Shuffle,
  Split as SplitIcon, Merge as MergeIcon, AlertTriangle, Hourglass,
  FileText, Wrench,
} from "lucide-react"
import { nodeStatusColor, visualNodeType, dockFraction, type CanvasNode, type VisualNodeType } from "./canvas-model"
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
 * The card contract the tests + inspectors depend on is preserved on every
 * INTERACTIVE type: data-testid=`wf-node-<id>`, aria-pressed, data-current,
 * click → onSelect. Sub/split/merge are non-interactive visual decoration. */

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
      ? <Zap className={cls} /> : <Clock className={cls} />
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

/* ── shared bits ─────────────────────────────────────────────────────────── */

const HANDLE_HIDDEN: React.CSSProperties = {
  opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1,
  border: "none", background: "transparent", pointerEvents: "none",
}

/** The 8 edge-anchor handles every node exposes (invisible, non-connectable);
 * edgeAnchors() picks the pair per edge by dominant axis. */
function AnchorHandles() {
  return (
    <>
      <Handle type="source" position={Position.Right} id="sr" style={HANDLE_HIDDEN} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="sb" style={HANDLE_HIDDEN} isConnectable={false} />
      <Handle type="source" position={Position.Left} id="sl" style={HANDLE_HIDDEN} isConnectable={false} />
      <Handle type="source" position={Position.Top} id="st" style={HANDLE_HIDDEN} isConnectable={false} />
      <Handle type="target" position={Position.Left} id="tl" style={HANDLE_HIDDEN} isConnectable={false} />
      <Handle type="target" position={Position.Top} id="tt" style={HANDLE_HIDDEN} isConnectable={false} />
      <Handle type="target" position={Position.Right} id="tr" style={HANDLE_HIDDEN} isConnectable={false} />
      <Handle type="target" position={Position.Bottom} id="tb" style={HANDLE_HIDDEN} isConnectable={false} />
    </>
  )
}

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

const RADIUS: Record<string, string> = { lg: "var(--radius-lg)", xl: "var(--radius-xl)" }

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

/* ── standard card (employee / engine / error / wait) ─────────────────────── */
function StandardNode({ node, selected, onSelect, t }: InnerProps & { t: VisualNodeType }) {
  const tint = TINT[t] ?? TINT.engine
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full items-center gap-3 rounded-[var(--radius-lg)] px-3.5 text-left transition-[box-shadow,transform] duration-200"
      style={{ background: "var(--bg-secondary)", boxShadow: cardShadow(node, selected), opacity: isDim(node) ? 0.55 : 1 }}
    >
      <span className="grid size-[38px] shrink-0 place-items-center rounded-[10px]" style={{ background: tint.bg, color: tint.fg }} aria-hidden>
        {typeIcon(node, t)}
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

/* ── trigger pill ─────────────────────────────────────────────────────────── */
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

/* ── approval gate ────────────────────────────────────────────────────────── */
function GateNode({ node, selected, onSelect }: InnerProps) {
  const tint = TINT.gate
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full items-center gap-3 rounded-[var(--radius-lg)] px-3.5 text-left transition-[box-shadow] duration-200"
      style={{ background: "var(--bg-secondary)", boxShadow: cardShadow(node, selected) }}
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

/* ── WIDE AI / engine node + sub-node docks ───────────────────────────────── */
function WideNode({ node, selected, onSelect }: InnerProps) {
  const tint = TINT.engine
  const docks = node.subNodes ?? []
  const engineLabel = node.model
    ? `${node.actorRef ?? (node.actorKind === "engine" ? "Engine" : "Claude")} · ${node.model}`
    : node.actorRef ?? "Engine"
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full flex-col rounded-[var(--radius-xl)] px-4 py-3 text-left transition-[box-shadow] duration-200"
      style={{ background: "var(--bg-secondary)", boxShadow: cardShadow(node, selected) }}
    >
      <span className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[11px]" style={{ background: tint.bg, color: tint.fg }} aria-hidden>
          {typeIcon(node, "wide")}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[length:var(--text-body)] font-[var(--weight-semibold)] leading-tight text-[var(--text-primary)]" title={node.title}>
            {node.title}
          </span>
          <span className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-[8px] px-2 py-0.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)]" style={{ background: "var(--fill-tertiary)", color: "var(--text-secondary)" }}>
            <span className="size-[5px] rounded-full" style={{ background: "var(--system-purple)" }} />{engineLabel}
          </span>
        </span>
      </span>
      {node.summary && (
        <span className="mt-2 line-clamp-3 text-[length:var(--text-caption1)] leading-snug text-[var(--text-secondary)]">{node.summary}</span>
      )}
      <span className="mt-2.5 flex items-center justify-between gap-2">
        <span className="flex gap-1.5">
          {docks.map((d) => (
            <span key={d.role} className="rounded-[7px] px-2 py-1 text-[9.5px] font-[var(--weight-semibold)] uppercase tracking-[0.04em]" style={{ background: "var(--fill-tertiary)", color: "var(--text-tertiary)" }}>
              {d.kind}
            </span>
          ))}
        </span>
        <StatusLine node={node} className="mt-0 shrink-0" />
      </span>
      {/* Underside dock source handles, one per attachable, aligned to its disc. */}
      {docks.map((d, i) => (
        <Handle
          key={`d${i}`}
          type="source"
          position={Position.Bottom}
          id={`d${i}`}
          style={{ ...HANDLE_HIDDEN, left: `${dockFraction(i, docks.length) * 100}%` }}
          isConnectable={false}
        />
      ))}
    </button>
  )
}

/* ── condition (IF / Switch) — grows with outputs ─────────────────────────── */
function CondNode({ node, selected, onSelect }: InnerProps) {
  const tint = TINT.cond
  const outs = node.outputs ?? [
    { id: "true", label: "true", tone: "true" as const },
    { id: "false", label: "false", tone: "false" as const },
  ]
  const isSwitch = outs.length > 2
  return (
    <button
      {...nodeButtonProps(node, selected, onSelect)}
      className="flex h-full w-full flex-col rounded-[var(--radius-lg)] px-3.5 py-3 text-left transition-[box-shadow] duration-200"
      style={{ background: "var(--bg-secondary)", boxShadow: cardShadow(node, selected) }}
    >
      <span className="flex items-center gap-2.5">
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
      <span className="mt-2.5 flex flex-col gap-1.5">
        {outs.map((o, i) => {
          const tone = o.tone ?? "neutral"
          const c = tone === "true" ? "var(--system-green)" : tone === "false" ? "var(--system-red)" : "var(--text-secondary)"
          const bg = tone === "true"
            ? "color-mix(in srgb, var(--system-green) 14%, transparent)"
            : tone === "false"
              ? "color-mix(in srgb, var(--system-red) 13%, transparent)"
              : "var(--fill-tertiary)"
          return (
            <span key={o.id} className="relative flex items-center justify-end">
              <span className="rounded-[7px] px-2.5 py-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)]" style={{ background: bg, color: c }}>
                {isSwitch ? `${i} · ${o.label}` : o.label}
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={`out-${i}`}
                style={{ ...HANDLE_HIDDEN, top: "50%" }}
                isConnectable={false}
              />
            </span>
          )
        })}
      </span>
    </button>
  )
}

/* ── split / merge glyphs (tiny, dedicated) ───────────────────────────────── */
function MiniGlyphNode({ node, t }: { node: CanvasNode; t: "split" | "merge" }) {
  return (
    <div data-node-id={node.id} className="flex h-full w-full flex-col items-center gap-1.5">
      <span className="grid size-[52px] place-items-center rounded-[15px]" style={{ background: "var(--bg-secondary)", boxShadow: "var(--shadow-card)", color: "var(--text-tertiary)" }} aria-hidden>
        {t === "split" ? <SplitIcon className="size-[22px] rotate-90" /> : <MergeIcon className="size-[22px] rotate-90" />}
      </span>
      <span className="text-[10px] font-[var(--weight-semibold)] uppercase tracking-[0.05em] text-[var(--text-tertiary)]">{t}</span>
      <AnchorHandles />
    </div>
  )
}

/* ── sub-node disc (attachable) ───────────────────────────────────────────── */
function SubNode({ node }: { node: CanvasNode }) {
  const role = node.subRole ?? "tool"
  const Icon = role === "model" ? FileText : role === "employee" ? User : Wrench
  return (
    <div data-node-id={node.id} className="flex h-full w-full flex-col items-center gap-1.5">
      <span className="text-[10px] font-[var(--weight-semibold)] uppercase tracking-[0.05em] text-[var(--text-quaternary)]">{node.subKind}</span>
      <span className="grid size-[46px] place-items-center rounded-full" style={{ background: "var(--bg-secondary)", boxShadow: "var(--shadow-card)", color: SUB_TINT[role] }} aria-hidden>
        <Icon className="size-[22px]" />
      </span>
      <span className="max-w-[76px] text-center text-[length:var(--text-caption2)] font-[var(--weight-semibold)] leading-tight text-[var(--text-secondary)]">{node.title}</span>
      <AnchorHandles />
    </div>
  )
}

/* ── dispatcher ───────────────────────────────────────────────────────────── */
export function JinnNode({ data }: NP) {
  const { node, selected, onSelect } = data
  const t = visualNodeType(node)
  let inner: React.ReactNode
  switch (t) {
    case "trigger": inner = <TriggerNode node={node} selected={selected} onSelect={onSelect} />; break
    case "wide": inner = <WideNode node={node} selected={selected} onSelect={onSelect} />; break
    case "gate": inner = <GateNode node={node} selected={selected} onSelect={onSelect} />; break
    case "cond": inner = <CondNode node={node} selected={selected} onSelect={onSelect} />; break
    case "split": return <MiniGlyphNode node={node} t="split" />
    case "merge": return <MiniGlyphNode node={node} t="merge" />
    case "sub": return <SubNode node={node} />
    default: inner = <StandardNode node={node} selected={selected} onSelect={onSelect} t={t} />
  }
  return (
    <div className="relative h-full w-full">
      {inner}
      <AnchorHandles />
    </div>
  )
}

export const jinnNodeTypes = { jinn: JinnNode }
