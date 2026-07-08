// The Todos display model (GRS-021d). Pure, framework-free view logic over the
// work-item wire types: the status→group mapping, the "Needs you" derivation,
// the per-person grouping, and the small provenance / monogram / cost helpers.
// The gateway owns the truth (status is derived server-side, spawn ≠ done); this
// module only *arranges* what it returns — it never invents a status.

import type {
  Employee,
  WorkItemCompactWire,
  WorkItemStatusWire,
  WorkItemSourceWire,
} from "./api"

// ── Display groups (the 5 board columns / mobile sections) ──────────────────
// The DB carries 8 statuses; the board shows 5 groups. `blocked` and `escalated`
// are attention states with no stored "base" status, so they fold into a fixed
// group and wear an in-place badge — the flow reads true and the badge tells the
// truth. `cancelled` is terminal-not-done and never shown on the board.
export type DisplayGroup = "backlog" | "assigned" | "executing" | "review" | "done"

export const DISPLAY_GROUPS: readonly DisplayGroup[] = [
  "backlog",
  "assigned",
  "executing",
  "review",
  "done",
]

export const DISPLAY_GROUP_LABEL: Record<DisplayGroup, string> = {
  backlog: "Backlog",
  assigned: "Assigned",
  executing: "Executing",
  review: "In review",
  done: "Done",
}

/** Which board group a status renders in (null = not shown on the board). */
export function displayGroupOf(status: WorkItemStatusWire): DisplayGroup | null {
  switch (status) {
    case "backlog":
      return "backlog"
    case "assigned":
      return "assigned"
    case "executing":
      return "executing"
    case "blocked":
      return "executing" // stuck work-in-progress, badged in place
    case "in_review":
      return "review"
    case "escalated":
      return "review" // awaiting the operator, badged in place
    case "done":
      return "done"
    case "cancelled":
      return null
  }
}

/** Human label for a raw status (sheet, people queue, sub-lines). */
export const STATUS_LABEL: Record<WorkItemStatusWire, string> = {
  backlog: "Backlog",
  assigned: "Assigned",
  executing: "Executing",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  escalated: "Escalated",
  cancelled: "Cancelled",
}

/** The attention overlay a status carries, if any. */
export type Attention = "blocked" | "escalated"
export function attentionOf(status: WorkItemStatusWire): Attention | null {
  if (status === "blocked") return "blocked"
  if (status === "escalated") return "escalated"
  return null
}

/** The glyph/colour key for a status circle. Distinct from the display group:
 *  a blocked card sits in Executing but keeps its blocked glyph + colour. */
export type StateKey =
  | "backlog"
  | "assigned"
  | "executing"
  | "review"
  | "done"
  | "blocked"
  | "escalated"
  | "cancelled"
export function stateKeyOf(status: WorkItemStatusWire): StateKey {
  return status === "in_review" ? "review" : status
}

// ── Terminal / open sets ────────────────────────────────────────────────────
const TERMINAL: ReadonlySet<WorkItemStatusWire> = new Set<WorkItemStatusWire>(["done", "cancelled"])
export function isOpen(status: WorkItemStatusWire): boolean {
  return !TERMINAL.has(status)
}

// ── Board grouping ──────────────────────────────────────────────────────────
export interface BoardGroup {
  group: DisplayGroup
  label: string
  items: WorkItemCompactWire[]
}

// Within a group, the group's "native" statuses sort before the folded-in
// attention statuses, so Executing reads executing→blocked and In review reads
// in_review→escalated (matching the approved mocks). Order is otherwise stable.
const WITHIN_GROUP_RANK: Record<WorkItemStatusWire, number> = {
  backlog: 0,
  assigned: 0,
  executing: 0,
  in_review: 0,
  done: 0,
  blocked: 1,
  escalated: 1,
  cancelled: 0,
}

/** Group a flat set of items into the 5 board columns. Cancelled is dropped. */
export function groupBoard(items: WorkItemCompactWire[]): BoardGroup[] {
  const buckets = new Map<DisplayGroup, WorkItemCompactWire[]>()
  for (const g of DISPLAY_GROUPS) buckets.set(g, [])
  for (const it of items) {
    const g = displayGroupOf(it.status)
    if (g) buckets.get(g)!.push(it)
  }
  return DISPLAY_GROUPS.map((g) => {
    const list = buckets.get(g)!.slice()
    // Stable sort: native status first, attention last.
    list.sort((a, b) => WITHIN_GROUP_RANK[a.status] - WITHIN_GROUP_RANK[b.status])
    return { group: g, label: DISPLAY_GROUP_LABEL[g], items: list }
  })
}

const DAY_MS = 24 * 60 * 60 * 1000
/** A done item counts for the recent window (default 7 days) by its updatedAt. */
export function isRecentDone(item: WorkItemCompactWire, now: number, windowDays = 7): boolean {
  if (item.status !== "done") return false
  const t = Date.parse(item.updatedAt)
  if (Number.isNaN(t)) return true // undated → keep rather than silently hide
  return now - t <= windowDays * DAY_MS
}

/** The header counts: open work + done in the recent window. */
export function headerCounts(items: WorkItemCompactWire[], now: number, windowDays = 7): { open: number; doneRecent: number } {
  let open = 0
  let doneRecent = 0
  for (const it of items) {
    if (isOpen(it.status)) open += 1
    else if (isRecentDone(it, now, windowDays)) doneRecent += 1
  }
  return { open, doneRecent }
}

// ── Needs-you inbox ─────────────────────────────────────────────────────────
// The gateway owns attention routing. GET /api/work-items?needsAttentionFor=me
// returns the caller-scoped queue newest-first; this helper only keeps the
// compact rows that still visibly need attention if an older gateway over-returns.
export type NeedsYouSet = WorkItemCompactWire[]

export function needsAttention(item: WorkItemCompactWire): boolean {
  return item.approvalState === "pending" || item.status === "escalated" || item.status === "blocked"
}

export function deriveNeedsYou(items: WorkItemCompactWire[]): NeedsYouSet {
  return items.filter(needsAttention)
}

export function needsYouCount(set: NeedsYouSet): number {
  return set.length
}

// ── People grouping ─────────────────────────────────────────────────────────
export interface PersonQueue {
  employee: Employee
  items: WorkItemCompactWire[]
  /** Distinct open statuses present, in a canonical order (for the dot row). */
  dist: WorkItemStatusWire[]
  openCount: number
}

const PEOPLE_STATUS_ORDER: readonly WorkItemStatusWire[] = [
  "executing",
  "in_review",
  "escalated",
  "assigned",
  "blocked",
  "backlog",
]
const PRIORITY_RANK: Record<WorkItemStatusWire, number> = {
  escalated: 0,
  blocked: 1,
  executing: 2,
  in_review: 3,
  assigned: 4,
  backlog: 5,
  done: 6,
  cancelled: 7,
}

/**
 * One queue per employee, open items only (done/cancelled excluded), sorted so
 * employees with work lead (by open count, then name) and idle employees ("All
 * clear") trail. Every roster employee gets a row so "what is everyone doing"
 * is answerable, but the caller may cap the idle tail for calm.
 */
export function groupPeople(items: WorkItemCompactWire[], employees: Employee[]): PersonQueue[] {
  const byAssignee = new Map<string, WorkItemCompactWire[]>()
  for (const it of items) {
    if (!isOpen(it.status) || !it.assignee) continue
    const list = byAssignee.get(it.assignee) ?? []
    list.push(it)
    byAssignee.set(it.assignee, list)
  }
  const queues = employees.map((employee): PersonQueue => {
    const list = (byAssignee.get(employee.name) ?? [])
      .slice()
      .sort((a, b) => PRIORITY_RANK[a.status] - PRIORITY_RANK[b.status])
    const present = new Set(list.map((i) => i.status))
    const dist = PEOPLE_STATUS_ORDER.filter((s) => present.has(s))
    return { employee, items: list, dist, openCount: list.length }
  })
  return queues.sort((a, b) => {
    if (b.openCount !== a.openCount) return b.openCount - a.openCount
    return a.employee.displayName.localeCompare(b.employee.displayName)
  })
}

// ── Provenance whisper ──────────────────────────────────────────────────────
const PROVENANCE_WORD: Record<WorkItemSourceWire, string> = {
  human: "You",
  delegation: "Delegation",
  cron: "Cron",
  workflow: "Workflow",
  session: "Session",
  connector: "Connector",
  goal: "Goal",
}

/** The "· <name>" suffix parsed from a machine-minted sourceRef, when present.
 *  `cron:<jobId>:<iso>` → jobId; `workflow:<defId>:<runId>` → defId. */
export function provenanceSuffix(source: WorkItemSourceWire, sourceRef?: string | null): string | null {
  if (!sourceRef) return null
  if (source === "cron") {
    const m = /^cron:([^:]+):/.exec(sourceRef)
    return m ? m[1] : null
  }
  if (source === "workflow") {
    const m = /^workflow:([^:]+):/.exec(sourceRef)
    return m ? m[1] : null
  }
  return null
}

export function provenanceLabel(source: WorkItemSourceWire, sourceRef?: string | null): string {
  const base = PROVENANCE_WORD[source]
  const suffix = provenanceSuffix(source, sourceRef)
  return suffix ? `${base} · ${suffix}` : base
}

// ── Verify policy + priority (mirror the gateway's provenance defaults so the
// sheet shows the SAME effective tier the server will enforce) ───────────────
export type VerifyMode = "trust" | "verify" | "thorough"
export const DEFAULT_VERIFY_MODE_BY_SOURCE: Record<WorkItemSourceWire, VerifyMode> = {
  cron: "trust",
  workflow: "trust",
  delegation: "verify",
  human: "verify",
  session: "verify",
  connector: "verify",
  goal: "verify",
}
export const DEFAULT_MAX_ROUNDS: Record<VerifyMode, number> = { trust: 2, verify: 2, thorough: 3 }

interface VerifyShape {
  source: WorkItemSourceWire
  verifyPolicy: { mode: VerifyMode; maxRounds?: number } | null
}
export function effectiveVerifyMode(item: VerifyShape): VerifyMode {
  return item.verifyPolicy?.mode ?? DEFAULT_VERIFY_MODE_BY_SOURCE[item.source]
}
export function effectiveMaxRounds(item: VerifyShape): number {
  return item.verifyPolicy?.maxRounds ?? DEFAULT_MAX_ROUNDS[effectiveVerifyMode(item)]
}

/** Priority int (0–3) → label. Higher int = higher priority; 2 is the default. */
export function priorityLabel(priority: number): string {
  return priority >= 3 ? "High" : priority === 2 ? "Medium" : priority === 1 ? "Low" : "None"
}

// ── Monogram + cost ─────────────────────────────────────────────────────────
/** Two-letter monogram from a display name (falls back to the first two chars). */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0] ?? name).slice(0, 2).toUpperCase()
}

function trimNum(n: number): string {
  // Whole dollars render without cents ("$10"); fractional keep two ("$2.10").
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** The cost pill text, only when a budget is set (null → render nothing). */
export function formatCost(spendUsd: number, budgetUsd: number | null | undefined): string | null {
  if (budgetUsd == null) return null
  return `$${spendUsd.toFixed(2)} / $${trimNum(budgetUsd)}`
}
