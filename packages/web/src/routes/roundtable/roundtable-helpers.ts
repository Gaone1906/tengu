import type { Employee, WorkItemCompactWire } from "@/lib/api"

/**
 * Pure helpers for the round-table dashboard (docs/tengu/18-council-specialists.md's
 * frontend plan), split out for unit testing without a DOM/render harness —
 * the same pattern chat-route-helpers.ts uses for the chat route.
 */

/** A "project" is a root Todo carrying a workspace path — the exact filter
 *  the deleted stand-up's `listStandupProjects()` used (roots without a
 *  workspace path are not necessarily Tengu projects, so they're excluded
 *  rather than shown as a blank card). */
export function projectsFromWorkItems(items: readonly WorkItemCompactWire[]): WorkItemCompactWire[] {
  return items.filter((item) => item.depth === 0 && !!item.workspacePath)
}

/** The council's Opus-tier generalists — every employee in the `generalists`
 *  department, sorted by display name for a stable seat order around the table. */
export function generalistsFromEmployees(employees: readonly Employee[]): Employee[] {
  return employees
    .filter((e) => e.department === "generalists")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface SeatPosition {
  /** Percent offset from the container center, e.g. -38..38. */
  xPct: number
  yPct: number
}

/**
 * Seat position for generalist `index` of `count` around an oval table,
 * starting at 12 o'clock and going clockwise. Pure trigonometry so the
 * layout is unit-testable without measuring a rendered DOM.
 */
export function seatPosition(index: number, count: number, radiusPct = 38): SeatPosition {
  if (count <= 0) return { xPct: 0, yPct: 0 }
  const angle = (2 * Math.PI * index) / count - Math.PI / 2
  return {
    xPct: Math.round(Math.cos(angle) * radiusPct * 100) / 100,
    yPct: Math.round(Math.sin(angle) * radiusPct * 100) / 100,
  }
}

export interface GeneralistProgressLike {
  assignee: string
  total: number
  completed: number
  inFlight: number
}

/** This generalist's rollup from the live `session:telemetry` broadcast's
 *  `employeeProgress` (progress.ts's `computeEmployeeProgress()`, already
 *  generic over any assignee — no backend change needed to read it here). */
export function progressForEmployee(
  name: string,
  employeeProgress: readonly GeneralistProgressLike[] | undefined,
): GeneralistProgressLike | null {
  return employeeProgress?.find((p) => p.assignee === name) ?? null
}

export function progressPct(progress: GeneralistProgressLike | null): number {
  if (!progress || progress.total === 0) return 0
  return Math.round((progress.completed / progress.total) * 1000) / 10
}
