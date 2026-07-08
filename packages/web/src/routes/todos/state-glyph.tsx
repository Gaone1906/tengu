import {
  Inbox,
  UserRound,
  Loader2,
  Search,
  Check,
  Pause,
  TriangleAlert,
  Bell,
  X,
  Clock,
  Workflow,
  MessageSquare,
  CornerDownRight,
  Target,
  Plug,
  type LucideIcon,
} from "lucide-react"
import type { WorkItemSourceWire, WorkItemStatusWire } from "@/lib/api"
import { stateKeyOf, type StateKey } from "@/lib/todos"

/* GRS-021d — the state-circle primitive. A tinted disc + a glyph from the same
 * lucide family the shipped Workflows surface uses (node-card `stateGlyph`), so
 * a Todo's status reads in the same visual language as a workflow step. The disc
 * treatment (soft tinted fill, no border) is the new primitive; the glyph inside
 * is the shared family. `approval` is a synthetic key for the Needs-you bell. */

export type StateGlyphKey = StateKey | "approval"

interface GlyphSpec {
  Icon: LucideIcon
  /** color-mix tint for the disc background (theme-aware via token). */
  bg: string
  /** glyph + text colour. */
  fg: string
  spin?: boolean
}

const SPEC: Record<StateGlyphKey, GlyphSpec> = {
  backlog: { Icon: Inbox, bg: "var(--fill-tertiary)", fg: "var(--text-tertiary)" },
  assigned: {
    Icon: UserRound,
    bg: "color-mix(in srgb, var(--system-blue) 16%, transparent)",
    fg: "var(--system-blue)",
  },
  executing: { Icon: Loader2, bg: "var(--accent-fill)", fg: "var(--accent)", spin: true },
  review: {
    Icon: Search,
    bg: "color-mix(in srgb, var(--system-purple) 18%, transparent)",
    fg: "var(--system-purple)",
  },
  done: {
    Icon: Check,
    bg: "color-mix(in srgb, var(--system-green) 16%, transparent)",
    fg: "var(--system-green)",
  },
  blocked: {
    Icon: Pause,
    bg: "color-mix(in srgb, var(--system-orange) 18%, transparent)",
    fg: "var(--system-orange)",
  },
  escalated: {
    Icon: TriangleAlert,
    bg: "color-mix(in srgb, var(--system-red) 18%, transparent)",
    fg: "var(--system-red)",
  },
  cancelled: { Icon: X, bg: "var(--fill-tertiary)", fg: "var(--text-quaternary)" },
  approval: { Icon: Bell, bg: "var(--accent-fill)", fg: "var(--accent)" },
}

export function specForStatus(status: WorkItemStatusWire): GlyphSpec {
  return SPEC[stateKeyOf(status)]
}

/** A tinted state disc. `size` is the disc diameter in px; the glyph scales to ~half. */
export function StateCircle({
  keyOf,
  size = 28,
  className,
}: {
  keyOf: StateGlyphKey
  size?: number
  className?: string
}) {
  const spec = SPEC[keyOf]
  const glyph = Math.round(size * 0.5)
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "grid",
        placeItems: "center",
        flex: "none",
        width: size,
        height: size,
        borderRadius: "50%",
        background: spec.bg,
        color: spec.fg,
      }}
    >
      <spec.Icon size={glyph} className={spec.spin ? "animate-spin" : undefined} strokeWidth={2} />
    </span>
  )
}

/** Convenience: a disc straight from a work-item status. */
export function StatusCircle({ status, size, className }: { status: WorkItemStatusWire; size?: number; className?: string }) {
  return <StateCircle keyOf={stateKeyOf(status)} size={size} className={className} />
}

// ── Provenance glyphs (the whisper icon). Same lucide family. ────────────────
const PROVENANCE_ICON: Record<WorkItemSourceWire, LucideIcon> = {
  human: UserRound,
  delegation: CornerDownRight,
  cron: Clock,
  workflow: Workflow,
  session: MessageSquare,
  connector: Plug,
  goal: Target,
}

export function ProvenanceIcon({ source, size = 12, className }: { source: WorkItemSourceWire; size?: number; className?: string }) {
  const Icon = PROVENANCE_ICON[source]
  return <Icon size={size} className={className} strokeWidth={1.75} aria-hidden />
}
