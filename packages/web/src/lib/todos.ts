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

// Ledger order (design-todos §4.2): in a vertical scan, what's moving right now
// comes first, what waits on a person beats what's merely queued, done trails.
export const DISPLAY_GROUPS: readonly DisplayGroup[] = [
  "executing",
  "review",
  "assigned",
  "backlog",
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

/** Group a flat set of items into the 5 ledger sections. Cancelled is dropped. */
export function groupBoard(items: WorkItemCompactWire[]): BoardGroup[] {
  const buckets = new Map<DisplayGroup, WorkItemCompactWire[]>()
  for (const g of DISPLAY_GROUPS) buckets.set(g, [])
  for (const it of items) {
    const g = displayGroupOf(it.status)
    if (g) buckets.get(g)!.push(it)
  }
  return DISPLAY_GROUPS.map((g) => {
    const list = buckets.get(g)!.slice()
    // Stable sort: native status first, attention folded after, then manual rank.
    list.sort((a, b) => WITHIN_GROUP_RANK[a.status] - WITHIN_GROUP_RANK[b.status] || compareRank(a, b))
    return { group: g, label: DISPLAY_GROUP_LABEL[g], items: list }
  })
}

// ── Manual rank ordering (design-todos §4.5 / §7.3) ─────────────────────────
// Default sort IS manual: rank ascending when present, then updatedAt desc for
// never-ranked items. Ranked items always lead unranked ones.
export function compareRank(a: WorkItemCompactWire, b: WorkItemCompactWire): number {
  const ar = a.rank ?? null
  const br = b.rank ?? null
  if (ar != null && br != null && ar !== br) return ar - br
  if (ar != null && br == null) return -1
  if (ar == null && br != null) return 1
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
}

/** The rank value that lands an item between its new neighbours (midpoint;
 *  open-ended steps of 1024 at either edge). Neighbours without a rank fall
 *  back to their list position so a drop into an unranked list still resolves. */
export function rankBetween(before: number | null | undefined, after: number | null | undefined): number {
  if (before != null && after != null) return (before + after) / 2
  if (before != null) return before + 1024
  if (after != null) return after - 1024
  return 0
}

const DAY_MS = 24 * 60 * 60 * 1000

const OPEN_STATUS_LIST: readonly WorkItemStatusWire[] = [
  "backlog", "assigned", "executing", "blocked", "in_review", "escalated",
]

/** Header counts from the gateway's TRUE per-status totals — never from a
 *  capped page of rows. The open-lens Done query is server-scoped to the
 *  recent window, so its total already means "done this week". */
export function headerCountsFromTotals(
  totals: Partial<Record<WorkItemStatusWire, number>>,
): { open: number; doneRecent: number } {
  const open = OPEN_STATUS_LIST.reduce((sum, s) => sum + (totals[s] ?? 0), 0)
  return { open, doneRecent: totals.done ?? 0 }
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

// ── Filters (design-todos §4.3) ─────────────────────────────────────────────
// The chips choose WHAT; the grouping adapts. Filters map 1:1 to server query
// params and persist in the URL. `status: "open"` is the default lens (the 6
// open statuses + the recent-done window); a closed status regroups by date.

export type StatusFilter = "open" | "all" | WorkItemStatusWire
export type DateFilter = "today" | "week" | "month"

export interface TodoFilters {
  status: StatusFilter
  assignee?: string
  department?: string
  source?: WorkItemSourceWire
  date?: DateFilter
  q?: string
}

export const DEFAULT_FILTERS: TodoFilters = { status: "open" }

export function isDefaultFilters(f: TodoFilters): boolean {
  return f.status === "open" && !f.assignee && !f.department && !f.source && !f.date && !f.q
}

/** How many chips are set away from their default (drives the Clear control). */
export function activeFilterCount(f: TodoFilters): number {
  let n = 0
  if (f.status !== "open") n++
  if (f.assignee) n++
  if (f.department) n++
  if (f.source) n++
  if (f.date) n++
  if (f.q) n++
  return n
}

/** Closed-status views (Done, Cancelled, All) regroup the list by date. */
export function isHistoryView(f: TodoFilters): boolean {
  return f.status === "done" || f.status === "cancelled" || f.status === "all"
}

/** The statuses the ledger must fetch for a given filter (server takes one
 *  status per query, so the data layer fans out and merges). */
export function statusesFor(f: TodoFilters): WorkItemStatusWire[] {
  if (f.status === "open") return ["backlog", "assigned", "executing", "blocked", "in_review", "escalated", "done"]
  if (f.status === "all")
    return ["backlog", "assigned", "executing", "blocked", "in_review", "escalated", "done", "cancelled"]
  return [f.status]
}

/** since/until ISO bounds for a date filter. `until` pins the window's upper
 *  edge explicitly so date-filtered queries (list AND search) are bounded on
 *  both sides server-side. */
export function dateBounds(date: DateFilter | undefined, now: number): { since?: string; until?: string } {
  if (!date) return {}
  const d = new Date(now)
  if (date === "today") {
    d.setHours(0, 0, 0, 0)
  } else if (date === "week") {
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - 6)
  } else {
    d.setHours(0, 0, 0, 0)
    d.setMonth(d.getMonth() - 1)
  }
  return { since: d.toISOString(), until: new Date(now).toISOString() }
}

// NOTE: there is deliberately NO client-side re-filter of server results. The
// gateway owns `q` (escaped-LIKE over title+body) and `since`/`until` on both
// list and search endpoints — a title-only client pass would silently discard
// body-only matches (shipped bug, QA 2026-07-10).

/** URL ⇄ filter mapping, so a filtered view is shareable and survives refresh. */
export function filtersToSearchParams(f: TodoFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.status !== "open") p.set("status", f.status)
  if (f.assignee) p.set("assignee", f.assignee)
  if (f.department) p.set("department", f.department)
  if (f.source) p.set("source", f.source)
  if (f.date) p.set("date", f.date)
  if (f.q) p.set("q", f.q)
  return p
}

const STATUS_FILTER_VALUES: ReadonlySet<string> = new Set([
  "all", "backlog", "assigned", "executing", "blocked", "in_review", "escalated", "done", "cancelled",
])
const SOURCE_VALUES: ReadonlySet<string> = new Set(["human", "delegation", "cron", "workflow", "session", "connector", "goal"])
const DATE_VALUES: ReadonlySet<string> = new Set(["today", "week", "month"])

export function filtersFromSearchParams(p: URLSearchParams): TodoFilters {
  const f: TodoFilters = { status: "open" }
  const status = p.get("status")
  if (status && STATUS_FILTER_VALUES.has(status)) f.status = status as StatusFilter
  const assignee = p.get("assignee")
  if (assignee) f.assignee = assignee
  const department = p.get("department")
  if (department) f.department = department
  const source = p.get("source")
  if (source && SOURCE_VALUES.has(source)) f.source = source as WorkItemSourceWire
  const date = p.get("date")
  if (date && DATE_VALUES.has(date)) f.date = date as DateFilter
  const q = p.get("q")
  if (q) f.q = q
  return f
}

// ── History grouping (closed-status filters regroup by date, §3) ────────────
export type DateBucket = "today" | "yesterday" | "week" | "earlier"
export const DATE_BUCKETS: readonly DateBucket[] = ["today", "yesterday", "week", "earlier"]
export const DATE_BUCKET_LABEL: Record<DateBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
}

export function dateBucketOf(iso: string, now: number): DateBucket {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "earlier"
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (t >= startOfToday.getTime()) return "today"
  if (t >= startOfToday.getTime() - DAY_MS) return "yesterday"
  if (t >= startOfToday.getTime() - 6 * DAY_MS) return "week"
  return "earlier"
}

export interface HistoryGroup {
  bucket: DateBucket
  label: string
  items: WorkItemCompactWire[]
}

/** Newest-first date grouping for history views. Empty buckets don't render. */
export function groupHistory(items: WorkItemCompactWire[], now: number): HistoryGroup[] {
  const buckets = new Map<DateBucket, WorkItemCompactWire[]>()
  for (const b of DATE_BUCKETS) buckets.set(b, [])
  for (const it of items) buckets.get(dateBucketOf(it.updatedAt, now))!.push(it)
  return DATE_BUCKETS.map((b) => {
    const list = buckets.get(b)!.slice()
    list.sort((a, x) => (Date.parse(x.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    return { bucket: b, label: DATE_BUCKET_LABEL[b], items: list }
  }).filter((g) => g.items.length > 0)
}
