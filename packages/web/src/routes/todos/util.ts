import type { Employee, WorkItemDetailWire } from "@/lib/api"

/** Compact relative time: "22m", "4h", "Yesterday", "Jul 4". Past only. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  const diff = Math.max(0, now - t)
  const min = Math.floor(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day === 1) return "Yesterday"
  if (day < 7) return `${day}d`
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** A short role line for a person row, e.g. "Platform · Senior". */
export function roleLabel(e: Employee): string {
  const dept = e.department ? cap(e.department) : ""
  const rank = e.rank ? cap(e.rank) : ""
  return [dept, rank].filter(Boolean).join(" · ")
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Resolve a display name for an assignee employee key, falling back to the key. */
export function displayNameOf(assignee: string | null, byName: Map<string, Employee>): string {
  if (!assignee) return ""
  return byName.get(assignee)?.displayName ?? assignee
}

/** The human reason a Todo is escalated/blocked: the newest event note/critique,
 *  else a calm fallback. Blocked/escalated transitions always carry a note. */
export function attentionReason(detail: WorkItemDetailWire, fallback: string): string {
  for (let i = detail.events.length - 1; i >= 0; i--) {
    const d = detail.events[i].detail
    if (!d) continue
    const text = (d.note ?? d.critique ?? d.reason) as unknown
    if (typeof text === "string" && text.trim()) return text.trim()
  }
  return fallback
}
