import type { CanvasNode, CanvasEdgeSpec } from "./canvas-model"

/* GRS-019c — hand-authored canvas fixtures that reproduce the approved mock
 * scenarios (hero 9-step, IF/Switch parallel). They drive the dev-only preview
 * route used for pixel-faithful screenshots AND a couple of render smoke tests,
 * so the screenshots exercise the REAL production node components — not a
 * separate mock. Pure data; no runtime/live coupling.
 *
 * These are illustrative graphs. Split/Merge are visual node types the canvas
 * renders when a graph carries them; the current backend schema doesn't emit
 * them yet (that's packages/jinn's lane), so real definitions fan edges
 * directly — the preview shows the full visual language the operator approved. */

export interface CanvasFixture {
  id: string
  title: string
  nodes: CanvasNode[]
  edges: CanvasEdgeSpec[]
}

const n = (node: Partial<CanvasNode> & Pick<CanvasNode, "id" | "kind" | "title" | "position">): CanvasNode => ({
  role: "step", who: "", status: "passed", isCurrent: false, gates: [], ...node,
})

/* ── Hero: the Sample Autonomy 9-step run ─────────────────────────────────────
 * trigger → plan → WIDE Build&test (+3 docks) → Split → Verify ∥ Red-team(fail)
 * → Merge → parked Quality gate → Ship (queued). */
export const HERO_FIXTURE: CanvasFixture = {
  id: "hero",
  title: "Sample Autonomy",
  nodes: [
    n({ id: "trig", kind: "trigger", title: "Pick next task", who: "schedule", position: { x: 0, y: 250 }, cadence: "Every 2 hours · until Jul 7", status: "passed" }),
    n({ id: "plan", kind: "step", visual: "engine", title: "Plan the work", position: { x: 220, y: 248 }, status: "passed", statusText: "Done · 12s" }),
    n({
      id: "build", kind: "step", title: "Build & test", position: { x: 470, y: 200 },
      actorKind: "engine", actorRef: "Claude", model: "Opus",
      summary: "Wrote 3 modules, 14 tests — all green.",
      subNodes: [
        { role: "model", kind: "MODEL", label: "Opus" },
        { role: "employee", kind: "EMPLOYEE", label: "Jinn Dev" },
        { role: "tool", kind: "TOOLS", label: "Shell · Tests" },
      ],
      status: "passed", statusText: "Done · 3m 40s",
    }),
    n({ id: "split", kind: "step", visual: "split", title: "Split", position: { x: 850, y: 250 }, status: "passed" }),
    n({ id: "ver", kind: "step", visual: "employee", title: "Verify", position: { x: 970, y: 168 }, status: "passed", statusText: "Passed" }),
    n({ id: "red", kind: "step", visual: "engine", title: "Red-team", position: { x: 970, y: 328 }, status: "blocked", statusText: "Failed · assertion" }),
    n({ id: "merge", kind: "step", visual: "merge", title: "Merge", position: { x: 1230, y: 250 }, status: "passed" }),
    n({ id: "gate", kind: "gate", title: "Quality gate", position: { x: 1350, y: 244 }, status: "parked" }),
    n({ id: "ship", kind: "step", visual: "employee", title: "Ship & report", position: { x: 1600, y: 248 }, status: "idle", statusText: "Queued" }),
  ],
  edges: [
    { id: "e1", from: "trig", to: "plan", items: 1 },
    { id: "e2", from: "plan", to: "build" },
    { id: "e3", from: "build", to: "split", items: 1 },
    { id: "e4", from: "split", to: "ver", items: 1 },
    { id: "e5", from: "split", to: "red" },
    { id: "e6", from: "ver", to: "merge" },
    { id: "e7", from: "red", to: "merge" },
    { id: "e8", from: "merge", to: "gate" },
    { id: "e9", from: "gate", to: "ship" },
  ],
}

/* ── IF — two-way branch (true/false → Merge) ───────────────────────────────*/
export const IF_FIXTURE: CanvasFixture = {
  id: "if",
  title: "IF · two-way branch",
  nodes: [
    n({ id: "check", kind: "step", visual: "engine", title: "Check result", position: { x: 0, y: 150 }, status: "passed", statusText: "Done" }),
    n({
      id: "cond", kind: "switch", title: "Passed?", position: { x: 250, y: 130 }, status: "passed",
      outputs: [{ id: "t", label: "true", tone: "true" }, { id: "f", label: "false", tone: "false" }],
    }),
    n({ id: "notify", kind: "step", visual: "employee", title: "Notify team", position: { x: 520, y: 60 }, status: "passed", statusText: "Done" }),
    n({ id: "bug", kind: "step", visual: "engine", title: "Open bug", position: { x: 520, y: 240 }, status: "idle", statusText: "Skipped" }),
    n({ id: "merge", kind: "step", visual: "merge", title: "Merge", position: { x: 800, y: 150 }, status: "passed" }),
    n({ id: "cont", kind: "step", visual: "employee", title: "Continue", position: { x: 920, y: 150 }, status: "idle", statusText: "Queued" }),
  ],
  edges: [
    { id: "e1", from: "check", to: "cond" },
    { id: "e2", from: "cond", to: "notify", outIndex: 0 },
    { id: "e3", from: "cond", to: "bug", outIndex: 1 },
    { id: "e4", from: "notify", to: "merge" },
    { id: "e5", from: "bug", to: "merge" },
    { id: "e6", from: "merge", to: "cont" },
  ],
}

/* ── Switch — N-way fan-out (0..3 → Merge) ──────────────────────────────────*/
export const SWITCH_FIXTURE: CanvasFixture = {
  id: "switch",
  title: "Switch · N-way fan-out",
  nodes: [
    n({ id: "route", kind: "step", visual: "engine", title: "Route ticket", position: { x: 0, y: 230 }, status: "passed", statusText: "Done" }),
    n({
      id: "sw", kind: "switch", title: "By topic", position: { x: 250, y: 180 }, status: "passed",
      outputs: [
        { id: "0", label: "Billing" }, { id: "1", label: "Bug" },
        { id: "2", label: "Sales" }, { id: "3", label: "Other" },
      ],
    }),
    n({ id: "billing", kind: "step", visual: "employee", title: "Billing bot", position: { x: 560, y: 60 }, status: "passed", statusText: "Done" }),
    n({ id: "eng", kind: "step", visual: "employee", title: "Eng triage", position: { x: 560, y: 170 }, status: "idle", statusText: "—" }),
    n({ id: "sales", kind: "step", visual: "employee", title: "Sales rep", position: { x: 560, y: 280 }, status: "idle", statusText: "—" }),
    n({ id: "auto", kind: "step", visual: "engine", title: "Auto-reply", position: { x: 560, y: 390 }, status: "idle", statusText: "—" }),
    n({ id: "merge", kind: "step", visual: "merge", title: "Merge", position: { x: 860, y: 230 }, status: "passed" }),
    n({ id: "log", kind: "step", visual: "employee", title: "Log outcome", position: { x: 980, y: 230 }, status: "idle", statusText: "Queued" }),
  ],
  edges: [
    { id: "e1", from: "route", to: "sw" },
    { id: "e2", from: "sw", to: "billing", outIndex: 0 },
    { id: "e3", from: "sw", to: "eng", outIndex: 1 },
    { id: "e4", from: "sw", to: "sales", outIndex: 2 },
    { id: "e5", from: "sw", to: "auto", outIndex: 3 },
    { id: "e6", from: "billing", to: "merge" },
    { id: "e7", from: "eng", to: "merge" },
    { id: "e8", from: "sales", to: "merge" },
    { id: "e9", from: "auto", to: "merge" },
    { id: "e10", from: "merge", to: "log" },
  ],
}

/* ── Wide AI node close-up (engine·model + task + MODEL/EMPLOYEE/TOOLS docks) ──*/
export const WIDE_FIXTURE: CanvasFixture = {
  id: "wide",
  title: "Engine step — the wide AI node",
  nodes: [
    n({ id: "plan", kind: "step", visual: "engine", title: "Plan the work", position: { x: 0, y: 40 }, status: "passed", statusText: "Done" }),
    n({
      id: "build", kind: "step", title: "Build & test", position: { x: 260, y: 0 },
      actorKind: "engine", actorRef: "Claude", model: "Opus",
      summary: "Implement the failing spec, write tests, run the suite until green.",
      subNodes: [
        { role: "model", kind: "MODEL", label: "Opus" },
        { role: "employee", kind: "EMPLOYEE", label: "Jinn Dev" },
        { role: "tool", kind: "TOOLS", label: "Shell · Tests" },
      ],
      status: "running", statusText: "Running · 2m 10s",
    }),
    n({ id: "verify", kind: "step", visual: "employee", title: "Verify", position: { x: 700, y: 40 }, status: "idle", statusText: "Queued" }),
  ],
  edges: [
    { id: "e1", from: "plan", to: "build" },
    { id: "e2", from: "build", to: "verify" },
  ],
}

export const PREVIEW_FIXTURES: Record<string, CanvasFixture> = {
  hero: HERO_FIXTURE,
  if: IF_FIXTURE,
  switch: SWITCH_FIXTURE,
  wide: WIDE_FIXTURE,
}
