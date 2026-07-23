// Todos v2 slice 6 — the ONE client-side legality map (design-doc §5, §7.3).
// Mirrors packages/jinn/src/work-items/transitions.ts for a MANUAL move made on
// the operator (human) surface: board drag, the status pickers, and keyboard
// moves all consume this module — never their own edge lists. The data lives in
// transition-edges.json; the gateway parity test
// (packages/jinn/src/work-items/__tests__/board-legality-parity.test.ts) probes
// the real transition() against that file, so drift fails a build, not a user.
//
// The UI pre-checks; the server stays the authority. A runtime refusal (version
// conflict, a child created mid-drag) still snaps back with the gateway's words.

import edgesFixture from "./transition-edges.json"
import type { WorkItemStatusWire } from "./api"

interface EdgesFixture {
  edges: Record<WorkItemStatusWire, WorkItemStatusWire[]>
  manualExecutingFrom: WorkItemStatusWire[]
  sticky: WorkItemStatusWire[]
  closeGated: WorkItemStatusWire[]
}

const FIXTURE = edgesFixture as unknown as EdgesFixture
const MANUAL_EXECUTING_FROM = new Set(FIXTURE.manualExecutingFrom)
const CLOSE_GATED = new Set(FIXTURE.closeGated)

/** One offered target. `gated` = the edge exists but a pre-checked server gate
 *  would refuse it right now — render disabled at 50% with the reason inline
 *  (never hide it: gated ≠ illegal, the design's "living proof" rule). */
export interface LegalTargetOption {
  status: WorkItemStatusWire
  gated: boolean
  reason?: string
}

export interface LegalTargetsContext {
  /** Count of this item's children not yet done/cancelled (from the card's own
   *  roll-up counts — the pre-check for the close gate). */
  openChildren?: number
}

/** Legal manual-move targets from `from` on the operator surface, in the
 *  gateway's declared edge order. Illegal edges are ABSENT (never disabled);
 *  gated edges are present with `gated: true` + the reason. */
export function legalTargets(
  from: WorkItemStatusWire,
  ctx: LegalTargetsContext = {},
): LegalTargetOption[] {
  const openChildren = ctx.openChildren ?? 0
  const out: LegalTargetOption[] = []
  for (const to of FIXTURE.edges[from] ?? []) {
    // Manual-start rule: a human move INTO executing is legal only from
    // backlog/assigned. From in_review, send back is a review verdict on the
    // item (bounce, rounds++), never a drag; from blocked/escalated, work
    // resumes through reassignment. Illegal ≠ gated: the edge is absent.
    if (to === "executing" && !MANUAL_EXECUTING_FROM.has(from)) continue
    if (CLOSE_GATED.has(to) && openChildren > 0) {
      out.push({
        status: to,
        gated: true,
        reason: `${openChildren} sub-task${openChildren === 1 ? "" : "s"} still open`,
      })
      continue
    }
    out.push({ status: to, gated: false })
  }
  return out
}

/** Drag convenience: a column is a live drop target only when the edge is
 *  legal AND ungated (a gated column dims like an illegal one — §5). */
export function canDropOn(
  from: WorkItemStatusWire,
  to: WorkItemStatusWire,
  ctx: LegalTargetsContext = {},
): boolean {
  return legalTargets(from, ctx).some((t) => t.status === to && !t.gated)
}
