import {
  CalendarClock,
  Flag,
  GitMerge,
  OctagonX,
  Radio,
  ShieldCheck,
  Split,
  SquareCheckBig,
  Timer,
  UserRound,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react"
import type { WorkflowNodeTypeV2, WorkflowNodeWire } from "./ports"

interface Tint {
  bg: string
  fg: string
}

const TINT: Record<WorkflowNodeTypeV2, Tint> = {
  trigger: { bg: "var(--accent-fill)", fg: "var(--accent)" },
  employee: { bg: "color-mix(in srgb, var(--system-blue) 15%, transparent)", fg: "var(--system-blue)" },
  condition: { bg: "color-mix(in srgb, var(--system-purple) 15%, transparent)", fg: "var(--system-purple)" },
  merge: { bg: "var(--fill-tertiary)", fg: "var(--text-secondary)" },
  approval: { bg: "color-mix(in srgb, var(--system-orange) 16%, transparent)", fg: "var(--system-orange)" },
  wait: { bg: "var(--fill-tertiary)", fg: "var(--text-secondary)" },
  end: { bg: "color-mix(in srgb, var(--system-green) 15%, transparent)", fg: "var(--system-green)" },
}

const END_FAILURE_TINT: Tint = { bg: "color-mix(in srgb, var(--system-red) 15%, transparent)", fg: "var(--system-red)" }

const TRIGGER_ICON: Record<string, LucideIcon> = {
  manual: Zap,
  schedule: CalendarClock,
  event: Radio,
  "todo-status": SquareCheckBig,
  "workflow-call": Workflow,
}

const TYPE_ICON: Record<WorkflowNodeTypeV2, LucideIcon> = {
  trigger: Zap,
  employee: UserRound,
  condition: Split,
  merge: GitMerge,
  approval: ShieldCheck,
  wait: Timer,
  end: Flag,
}

function iconFor(type: WorkflowNodeTypeV2, node?: WorkflowNodeWire): { Icon: LucideIcon; tint: Tint } {
  if (type === "trigger" && node) {
    const kind = (node.config as { kind?: unknown }).kind
    const Icon = typeof kind === "string" ? (TRIGGER_ICON[kind] ?? Zap) : Zap
    return { Icon, tint: TINT.trigger }
  }
  if (type === "end" && node && (node.config as { result?: unknown }).result === "failure") {
    return { Icon: OctagonX, tint: END_FAILURE_TINT }
  }
  return { Icon: TYPE_ICON[type], tint: TINT[type] }
}

/** The type-identity tile: tinted rounded square + glyph, sized for cards and menus. */
export function NodeTypeIcon({
  type,
  node,
  size = 32,
  iconSize = 15,
}: {
  type: WorkflowNodeTypeV2
  node?: WorkflowNodeWire
  size?: number
  iconSize?: number
}) {
  const { Icon, tint } = iconFor(type, node)
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[9px]"
      style={{ width: size, height: size, background: tint.bg, color: tint.fg }}
    >
      <Icon size={iconSize} strokeWidth={2} />
    </span>
  )
}
