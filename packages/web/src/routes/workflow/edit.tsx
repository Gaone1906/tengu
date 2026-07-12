import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, Clock, ListChecks, Loader2, Network, Play, Plus, Radio, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react"
import {
  api,
  type CreateWorkflowTriggerInputWire,
  type EditableWorkflowDefinitionWire,
  type StepNodeOptionsWire,
  type WorkflowConditionWire,
  type WorkflowEdgeWire,
  type WorkflowLayoutWire,
  type WorkflowNodeWire,
  type WorkflowTriggerBindingWire,
  type WorkflowValidationError,
  type WorkItemStatusWire,
} from "@/lib/api"
import { WorkflowCanvas, buildCanvasNodes, deriveDisplayFields, type CanvasNode, type CanvasEdgeSpec } from "./canvas"
import { InspectorPanel, InspectorSheet } from "./inspector-shell"

/* GRS-011c-1 — canvas Edit mode (MVP).
 *
 * Run view (page.tsx + canvas.tsx) renders DERIVED run state and is read-only.
 * Edit view (this file) renders the DURABLE editable definition
 * (EditableWorkflowDefinition) on the SAME WorkflowCanvas and lets the operator
 * change node properties (label + cadence) and save them back through the
 * GRS-011b CRUD API. Editing a definition never touches run receipts — the two
 * are distinct artifacts on disk.
 *
 * This slice deliberately ships property editing only: node label + cadence,
 * Save (PUT with expectedVersion optimistic lock), inline validation errors,
 * and a dirty-state guard. Drag/reposition, add-node, connect-edge, and
 * duplicate/retire are GRS-011c-2.
 *
 * The pure helpers (nodesForDefinition / applyNodeEdit / isDirty / buildPatch)
 * are exported so they can be unit-tested without the gateway; WorkflowEditView
 * owns fetching + save. */

/** Retry causes offered by the inspector (mirrors STEP_RETRY_CAUSES, GRS-016b). */
export const RETRY_CAUSE_CHOICES = ["error", "no-output", "interrupted", "timeout"] as const

/** Effort levels offered by the inspector (mirrors STEP_EFFORT_LEVELS, GRS-016b). */
export const EFFORT_CHOICES = ["low", "medium", "high", "xhigh"] as const

/** Condition operators offered by the inspector (mirrors CONDITION_OPS, GRS-016c). */
export const CONDITION_OP_CHOICES = [
  "eq", "ne", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "absent",
] as const

const TODO_STATUS_CHOICES: WorkItemStatusWire[] = [
  "backlog",
  "assigned",
  "executing",
  "blocked",
  "in_review",
  "escalated",
  "done",
]

type WakeUpKind = "manual" | "schedule" | "todo-status" | "event" | "poll"

interface WakeUpDraft {
  kind: WakeUpKind
  cron: string
  timezone: string
  toStatus: string
  fromStatus: string
  filterAssignee: string
  filterDepartment: string
  filterSource: string
  triggerName: string
  eventName: string
  secretToken: string
  command: string
  intervalSeconds: string
}

const EMPTY_WAKE_UP: WakeUpDraft = {
  kind: "manual",
  cron: "",
  timezone: "",
  toStatus: "in_review",
  fromStatus: "",
  filterAssignee: "",
  filterDepartment: "",
  filterSource: "",
  triggerName: "",
  eventName: "",
  secretToken: "",
  command: "",
  intervalSeconds: "300",
}

function trimValue(value: string): string {
  return value.trim()
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function triggerNodeOf(def: EditableWorkflowDefinitionWire): WorkflowNodeWire | null {
  return def.nodes.find((n) => n.type === "trigger") ?? null
}

function activeTriggerBindingFor(
  workflowId: string,
  bindings: WorkflowTriggerBindingWire[],
): WorkflowTriggerBindingWire | null {
  return [...bindings]
    .filter((b) => b.targetWorkflowId === workflowId && (
      b.activation !== "disabled" || (b.kind === "poll" && b.approval?.state === "rejected")
    ))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))[0] ?? null
}

function wakeUpDraftFromDefinition(
  def: EditableWorkflowDefinitionWire,
  bindings: WorkflowTriggerBindingWire[],
): WakeUpDraft {
  const binding = activeTriggerBindingFor(def.id, bindings)
  if (binding?.kind === "webhook") {
    return {
      ...EMPTY_WAKE_UP,
      kind: "event",
      triggerName: binding.name,
      eventName: binding.event,
    }
  }
  if (binding?.kind === "poll") {
    return {
      ...EMPTY_WAKE_UP,
      kind: "poll",
      triggerName: binding.name,
      eventName: binding.event,
      command: binding.command ?? "",
      intervalSeconds: binding.intervalSeconds ? String(binding.intervalSeconds) : EMPTY_WAKE_UP.intervalSeconds,
    }
  }

  const trigger = triggerNodeOf(def)?.trigger ?? {}
  const kind = typeof trigger.kind === "string" ? trigger.kind : "manual"
  if (kind === "schedule") {
    return {
      ...EMPTY_WAKE_UP,
      kind: "schedule",
      cron: stringField(trigger.cron),
      timezone: stringField(trigger.timezone),
    }
  }
  if (kind === "todo-status-change") {
    const filter = trigger.filter && typeof trigger.filter === "object" && !Array.isArray(trigger.filter)
      ? trigger.filter as Record<string, unknown>
      : {}
    return {
      ...EMPTY_WAKE_UP,
      kind: "todo-status",
      toStatus: stringField(trigger.toStatus) || EMPTY_WAKE_UP.toStatus,
      fromStatus: stringField(trigger.fromStatus),
      filterAssignee: stringField(filter.assignee),
      filterDepartment: stringField(filter.department),
      filterSource: stringField(filter.source),
    }
  }
  return { ...EMPTY_WAKE_UP }
}

function normalizedWakeUp(draft: WakeUpDraft): Record<string, unknown> {
  if (draft.kind === "schedule") {
    return {
      kind: draft.kind,
      cron: trimValue(draft.cron),
      timezone: trimValue(draft.timezone),
    }
  }
  if (draft.kind === "todo-status") {
    return {
      kind: draft.kind,
      toStatus: trimValue(draft.toStatus) || EMPTY_WAKE_UP.toStatus,
      fromStatus: trimValue(draft.fromStatus),
      filterAssignee: trimValue(draft.filterAssignee),
      filterDepartment: trimValue(draft.filterDepartment),
      filterSource: trimValue(draft.filterSource),
    }
  }
  if (draft.kind === "event") {
    return {
      kind: draft.kind,
      triggerName: trimValue(draft.triggerName),
      eventName: trimValue(draft.eventName),
      secretToken: trimValue(draft.secretToken),
    }
  }
  if (draft.kind === "poll") {
    return {
      kind: draft.kind,
      triggerName: trimValue(draft.triggerName),
      eventName: trimValue(draft.eventName),
      command: trimValue(draft.command),
      intervalSeconds: Number(trimValue(draft.intervalSeconds)),
    }
  }
  return { kind: "manual" }
}

function wakeUpKey(draft: WakeUpDraft): string {
  return canonical(normalizedWakeUp(draft))
}

function wakeUpDirty(
  def: EditableWorkflowDefinitionWire,
  bindings: WorkflowTriggerBindingWire[],
  draft: WakeUpDraft,
): boolean {
  return wakeUpKey(draft) !== wakeUpKey(wakeUpDraftFromDefinition(def, bindings))
}

function validCronShape(value: string): boolean {
  return trimValue(value).split(/\s+/).length === 5
}

function wakeUpValid(draft: WakeUpDraft): boolean {
  if (draft.kind === "manual") return true
  if (draft.kind === "schedule") return validCronShape(draft.cron)
  if (draft.kind === "todo-status") return trimValue(draft.toStatus) !== ""
  if (draft.kind === "event") return trimValue(draft.triggerName) !== "" && trimValue(draft.eventName) !== ""
  const interval = Number(trimValue(draft.intervalSeconds))
  return (
    trimValue(draft.triggerName) !== "" &&
    trimValue(draft.eventName) !== "" &&
    trimValue(draft.command) !== "" &&
    Number.isInteger(interval) &&
    interval > 0
  )
}

function definitionTriggerForWakeUp(draft: WakeUpDraft): Record<string, unknown> {
  if (draft.kind === "schedule") {
    return {
      kind: "schedule",
      cron: trimValue(draft.cron),
      ...(trimValue(draft.timezone) !== "" ? { timezone: trimValue(draft.timezone) } : {}),
    }
  }
  if (draft.kind === "todo-status") {
    const filter = {
      ...(trimValue(draft.filterAssignee) !== "" ? { assignee: trimValue(draft.filterAssignee) } : {}),
      ...(trimValue(draft.filterDepartment) !== "" ? { department: trimValue(draft.filterDepartment) } : {}),
      ...(trimValue(draft.filterSource) !== "" ? { source: trimValue(draft.filterSource) } : {}),
    }
    return {
      kind: "todo-status-change",
      toStatus: trimValue(draft.toStatus) || EMPTY_WAKE_UP.toStatus,
      ...(trimValue(draft.fromStatus) !== "" ? { fromStatus: trimValue(draft.fromStatus) } : {}),
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    }
  }
  return { kind: "manual" }
}

function wakeUpLabel(draft: WakeUpDraft): string {
  if (draft.kind === "schedule") return "Schedule"
  if (draft.kind === "todo-status") return "Todo status"
  if (draft.kind === "event") return "Event"
  if (draft.kind === "poll") return "Poll"
  return "Manual"
}

function buildWakeUpNodesPatch(
  def: EditableWorkflowDefinitionWire,
  nodes: WorkflowNodeWire[],
  draft: WakeUpDraft,
): WorkflowNodeWire[] {
  const triggerNode = triggerNodeOf(def)
  if (!triggerNode) return nodes
  return nodes.map((n) =>
    n.id === triggerNode.id
      ? { ...n, label: wakeUpLabel(draft), trigger: definitionTriggerForWakeUp(draft) }
      : n,
  )
}

function bindingInputForWakeUp(workflowId: string, draft: WakeUpDraft): CreateWorkflowTriggerInputWire | null {
  if (draft.kind === "event") {
    return {
      kind: "webhook",
      name: trimValue(draft.triggerName),
      event: trimValue(draft.eventName),
      targetWorkflowId: workflowId,
      ...(trimValue(draft.secretToken) !== "" ? { secretToken: trimValue(draft.secretToken) } : {}),
    }
  }
  if (draft.kind === "poll") {
    return {
      kind: "poll",
      name: trimValue(draft.triggerName),
      event: trimValue(draft.eventName),
      targetWorkflowId: workflowId,
      command: trimValue(draft.command),
      intervalSeconds: Number(trimValue(draft.intervalSeconds)),
    }
  }
  return null
}

function bindingMatchesInput(
  binding: WorkflowTriggerBindingWire,
  input: CreateWorkflowTriggerInputWire,
): boolean {
  if (binding.kind !== input.kind || binding.name !== input.name || binding.event !== input.event) return false
  if (binding.targetWorkflowId !== input.targetWorkflowId) return false
  if (input.kind === "poll") {
    return binding.command === input.command && binding.intervalSeconds === input.intervalSeconds
  }
  return !input.secretToken
}

async function saveWakeUpBindings(
  workflowId: string,
  currentBindings: WorkflowTriggerBindingWire[],
  draft: WakeUpDraft,
): Promise<WorkflowTriggerBindingWire[]> {
  const current = activeTriggerBindingFor(workflowId, currentBindings)
  const input = bindingInputForWakeUp(workflowId, draft)
  if (!input) {
    if (current) await api.deleteWorkflowTrigger(current.name)
    return current ? currentBindings.filter((b) => b.name !== current.name) : currentBindings
  }

  const same = current ? bindingMatchesInput(current, input) : false
  if (current && same) return currentBindings
  if (current && current.name === input.name) {
    throw new Error("Choose a new trigger name when changing an existing wake-up binding.")
  }

  const created = await api.createWorkflowTrigger(input)
  if (current) await api.deleteWorkflowTrigger(current.name)
  return [
    ...currentBindings.filter((b) => !current || b.name !== current.name),
    created.trigger,
  ]
}

/** One drafted condition row (GRS-016c). `value` is string-drafted with an explicit
 * type selector — a routing comparison must never depend on a silent numeric guess
 * ("3" vs 3 is a type-mismatch = never-matching rule). */
export interface ConditionRowDraft {
  path: string
  op: string
  value: string
  valueType: "string" | "number" | "boolean"
}

/** One switch out-edge's drafted rule set. Empty rows = the default branch. */
export interface BranchDraft {
  edgeId: string
  to: string
  rows: ConditionRowDraft[]
}

/** One drafted out-edge lane row (GRS-016d): `error` marks the edge as the
 * failure route of an onError:'error-edge' step (persisted as lane:'error'). */
export interface LaneDraft {
  edgeId: string
  to: string
  error: boolean
}

/** Editable-per-node fields. Option fields (GRS-016b) are string-drafted plain
 * controls ("" = unset → the field is OMITTED on save, never persisted empty);
 * the polished pickers land with the GRS-016f inspector substrate. */
export interface NodeDraft {
  label: string
  cadence: string
  /** Step task text (GRS-014c) — what the spawned session is asked to do. Step-only. */
  instructions: string
  /** GRS-016b engine-node options (step-only, actor required). OPTIONAL on the
   * draft shape (absent = unset) so pre-016b draft literals stay valid; the
   * hydrator always fills them. */
  model?: string
  effort?: string
  output?: string
  onError?: string
  retryMaxAttempts?: string
  retryOn?: string[]
  timeoutMinutes?: string
  /** GRS-016e session mode ("" = fresh default → the key is dropped on save). */
  sessionMode?: string
  /** GRS-016e: the live gateway session an 'existing'-mode step posts into.
   * A SUB-SETTING of sessionMode === "existing" — encoded only then (the 016d-fix
   * orphaned-sub-setting precedent). */
  sessionId?: string
  /** GRS-016c switch node: evaluation mode ("" = firstMatch default). */
  switchMode?: string
  /** GRS-016c fail node: the authored stop-and-error message. */
  failMessage?: string
  /** GRS-016c switch node: one drafted rule set per non-loop out-edge. */
  branches?: BranchDraft[]
  /** GRS-016d wait node: duration in minutes / absolute ISO deadline
   * (string-drafted; the server validator enforces exactly-one + bounds). */
  waitMinutes?: string
  waitUntil?: string
  /** GRS-016d actor step: one lane row per non-loop out-edge (rendered when
   * onError is "error-edge"; persisted as lane:'error' on the checked edges). */
  errorLanes?: LaneDraft[]
}

/** Order a definition's nodes into a render chain: trigger node(s) first, then
 * the rest in DECLARATION order.
 *
 * We deliberately do NOT follow the edge list to build the chain. The migration
 * (and any sane authoring) emits `nodes[]` already in the intended visual order,
 * and WorkflowCanvas draws edges between CONSECUTIVE nodes. Edge-following breaks
 * on the real sample-autonomy graph: `adversary` owns a `handoff` shortcut edge
 * (adversary→decide) declared before its `sequence` backbone edge
 * (adversary→steer), so following the first outgoing edge would reorder the
 * chain and draw fake edges (Codex GRS-011c-1 Major 1). Declaration order is
 * correct for the linear fixture and stable for anything else. A true branching
 * layout that honours the full edge list is GRS-011c-2. */
export function orderDefinitionNodes(def: EditableWorkflowDefinitionWire): WorkflowNodeWire[] {
  const triggers = def.nodes.filter((n) => n.type === "trigger")
  const rest = def.nodes.filter((n) => n.type !== "trigger")
  return [...triggers, ...rest]
}

/** Map an editable definition to canvas nodes. Definitions have no run state, so
 * every node reads as a neutral "draft" (grey) — we never fake pass/fail here.
 * Gate specs are configuration, not receipts, so `gates` is left empty (the
 * node-card pass-count chip stays hidden); their detail belongs in the inspector.
 * Thin adapter over the shared builder (GRS-013): no synthetic trigger — the
 * definition renders its own real nodes, at their stored x/y positions. */
export function nodesForDefinition(
  def: EditableWorkflowDefinitionWire,
  drafts?: Record<string, NodeDraft>,
): CanvasNode[] {
  return buildCanvasNodes({
    steps: orderDefinitionNodes(def).map((n) => {
      const d = drafts?.[n.id]
      const who =
        n.actor?.ref ??
        (n.type === "trigger" ? "schedule"
          : n.type === "gate" ? "gate"
          : n.type === "switch" ? "switch"
          : n.type === "fail" ? "fail"
          : n.type === "wait" ? "wait"
          : "—")
      return {
        id: n.id,
        kind: n.type,
        title: (d?.label ?? n.label) || "(untitled)",
        role: n.role ?? n.type,
        who,
        status: "draft",
        cadence: d?.cadence || n.cadence,
        optional: n.optional,
        position: n.position,
        // Per-type visual (GRS-019c): engine·model, the WIDE node + docks when the
        // step carries a task, a switch's stacked output ports. Derived from the
        // saved node; edits re-derive on save.
        ...deriveDisplayFields(n, def.edges.filter((e) => e.from === n.id)),
      }
    }),
  })
}

/** The definition's REAL edges for the spatial canvas — the Editor lens draws
 * the same topology the run lens replays, so switching lens moves zero
 * geometry. Switch/IF out-edges carry their output-row index (the same
 * lane!=='error' ordering deriveDisplayFields builds the port rows from), so
 * each branch wire leaves its row's port on the card wall. Pure; unit-tested. */
export function edgesForDefinition(def: EditableWorkflowDefinitionWire): CanvasEdgeSpec[] {
  const outsBySwitch = new Map<string, string[]>()
  for (const n of def.nodes) {
    if (n.type !== "switch") continue
    outsBySwitch.set(n.id, def.edges.filter((e) => e.from === n.id && e.lane !== "error").map((e) => e.id))
  }
  return def.edges.map((e) => {
    const spec: CanvasEdgeSpec = { id: e.id, from: e.from, to: e.to, kind: e.kind }
    if (e.lane !== undefined) spec.lane = e.lane
    const outs = outsBySwitch.get(e.from)
    if (outs) {
      const i = outs.indexOf(e.id)
      if (i >= 0) spec.outIndex = i
    }
    return spec
  })
}

/** An EMPTY definition (trigger only) teaches the wire direction with a ghost
 * "+ Add step" outline one gap right of the trigger's output port (spec §7).
 * Decoration only — node authoring (the palette) is the Phase-3 editor scope. */
export function ghostNodeForDefinition(def: EditableWorkflowDefinitionWire): CanvasNode | null {
  const hasSteps = def.nodes.some((n) => n.type !== "trigger")
  if (hasSteps) return null
  const trigger = def.nodes.find((n) => n.type === "trigger")
  if (!trigger?.position) return null
  return {
    id: "__ghost__",
    kind: "step",
    visual: "ghost",
    title: "Add step",
    role: "ghost",
    who: "",
    status: "draft",
    isCurrent: false,
    gates: [],
    position: { x: trigger.position.x + 188 + 96, y: trigger.position.y - 4 },
  }
}

/** Hydrate one persisted condition into a drafted row: the value is string-drafted
 * and its JSON type is remembered explicitly so a save re-encodes it losslessly. */
function rowFromCondition(c: WorkflowConditionWire): ConditionRowDraft {
  return {
    path: c.path,
    op: c.op,
    value: c.value === undefined ? "" : String(c.value),
    valueType: typeof c.value === "number" ? "number" : typeof c.value === "boolean" ? "boolean" : "string",
  }
}

/** Return the initial editable drafts for every node in the definition. */
export function draftsFromDefinition(def: EditableWorkflowDefinitionWire): Record<string, NodeDraft> {
  const out: Record<string, NodeDraft> = {}
  for (const n of def.nodes) {
    const o = n.options
    out[n.id] = {
      label: n.label,
      cadence: n.cadence ?? "",
      instructions: n.instructions ?? "",
      model: o?.model ?? "",
      effort: o?.effort ?? "",
      output: o?.output ?? "",
      onError: o?.onError ?? "",
      retryMaxAttempts: o?.retry ? String(o.retry.maxAttempts) : "",
      retryOn: o?.retry ? [...o.retry.on] : [],
      timeoutMinutes: o?.timeoutMinutes !== undefined ? String(o.timeoutMinutes) : "",
      sessionMode: o?.session?.mode ?? "",
      sessionId: o?.session?.sessionId ?? "",
      switchMode: n.switchMode ?? "",
      failMessage: n.failMessage ?? "",
      waitMinutes: n.waitMinutes !== undefined ? String(n.waitMinutes) : "",
      waitUntil: n.waitUntil ?? "",
      // GRS-016c: a switch node's rules live on its OUT-EDGES; the inspector edits
      // them through the node's draft (one branch per non-loop out-edge, edge
      // declaration order — the routing order).
      ...(n.type === "switch"
        ? {
            branches: def.edges
              .filter((e) => e.from === n.id && e.kind !== "loop")
              .map((e) => ({ edgeId: e.id, to: e.to, rows: (e.when ?? []).map(rowFromCondition) })),
          }
        : {}),
      // GRS-016d: an actor step's error-lane markers also live on its OUT-EDGES
      // (one row per non-loop out-edge; checked = lane:'error' persisted).
      ...(n.type === "step" && n.actor
        ? {
            errorLanes: def.edges
              .filter((e) => e.from === n.id && e.kind !== "loop")
              .map((e) => ({ edgeId: e.id, to: e.to, error: e.lane === "error" })),
          }
        : {}),
    }
  }
  return out
}

/** Encode drafted rows back to wire conditions: blank-path rows are dropped,
 * exists/absent carry no value, and the value's declared type wins ("3" as a
 * string stays a string). Empty result → undefined (the edge has no `when` key —
 * it is the switch's default branch). */
export function conditionsFromRows(rows: ConditionRowDraft[]): WorkflowConditionWire[] | undefined {
  const out: WorkflowConditionWire[] = []
  for (const r of rows) {
    const path = r.path.trim()
    if (path === "") continue
    const valueless = r.op === "exists" || r.op === "absent"
    out.push({
      path,
      op: r.op,
      ...(valueless
        ? {}
        : { value: r.valueType === "number" ? Number(r.value) : r.valueType === "boolean" ? r.value === "true" : r.value }),
    })
  }
  return out.length > 0 ? out : undefined
}

/** The options object a draft encodes, or undefined when every option is unset —
 * the round-trip rule: "" never persists, an all-empty draft drops the key. Retry
 * is emitted only when maxAttempts is set (the causes checkboxes alone mean
 * nothing); the server validator remains the authority on values. */
export function optionsFromDraft(d: NodeDraft): StepNodeOptionsWire | undefined {
  const model = (d.model ?? "").trim()
  const retryMax = (d.retryMaxAttempts ?? "").trim()
  const timeout = (d.timeoutMinutes ?? "").trim()
  // Session (GRS-016e): sessionId is a SUB-SETTING of mode "existing" — switching
  // the mode away drops a stale id in the SAME save (the 016d-fix precedent), so
  // the persisted definition is always valid. An id typed but left blank is still
  // omitted; the server validator then surfaces "existing requires a sessionId".
  const sessionId = (d.sessionId ?? "").trim()
  const session: StepNodeOptionsWire["session"] | undefined = d.sessionMode
    ? {
        mode: d.sessionMode as NonNullable<StepNodeOptionsWire["session"]>["mode"],
        ...(d.sessionMode === "existing" && sessionId !== "" ? { sessionId } : {}),
      }
    : undefined
  const out: StepNodeOptionsWire = {
    ...(model !== "" ? { model: d.model } : {}),
    ...(d.effort ? { effort: d.effort } : {}),
    ...(d.output ? { output: d.output as StepNodeOptionsWire["output"] } : {}),
    ...(retryMax !== ""
      ? { retry: { maxAttempts: Number(retryMax), on: [...(d.retryOn ?? [])] } }
      : {}),
    ...(d.onError ? { onError: d.onError as StepNodeOptionsWire["onError"] } : {}),
    ...(timeout !== "" ? { timeoutMinutes: Number(timeout) } : {}),
    ...(session ? { session } : {}),
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Key-order-insensitive stringify — the drafts re-encode options in a fixed key
 * order, and a mere key-order difference from the file must never read as dirty. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  )
}

export interface WorkflowGraphDraft {
  nodes: WorkflowNodeWire[]
  edges: WorkflowEdgeWire[]
  layout?: WorkflowLayoutWire
}

const MANUAL_LAYOUT: WorkflowLayoutWire = { source: "manual", version: 1 }
const GRAPH_GRID = 20

function snapToGrid(value: number): number {
  return Math.round(value / GRAPH_GRID) * GRAPH_GRID
}

function uniqueGraphId(base: string, taken: Set<string>): string {
  const safe = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "node"
  if (!taken.has(safe)) return safe
  let suffix = 2
  while (taken.has(`${safe}-${suffix}`)) suffix += 1
  return `${safe}-${suffix}`
}

export function graphFromDefinition(definition: EditableWorkflowDefinitionWire): WorkflowGraphDraft {
  return {
    nodes: definition.nodes.map((node) => ({ ...node, position: { ...node.position } })),
    edges: definition.edges.map((edge) => ({ ...edge })),
    ...(definition.layout ? { layout: { ...definition.layout } } : {}),
  }
}

export function moveNode(
  graph: WorkflowGraphDraft,
  nodeId: string,
  position: WorkflowNodeWire["position"],
): WorkflowGraphDraft {
  if (!graph.nodes.some((node) => node.id === nodeId)) return graph
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === nodeId
      ? { ...node, position: { x: snapToGrid(position.x), y: snapToGrid(position.y) } }
      : node),
    layout: MANUAL_LAYOUT,
  }
}

export function connectNodes(graph: WorkflowGraphDraft, from: string, to: string): WorkflowGraphDraft {
  if (from === to) return graph
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  if (!nodeIds.has(from) || !nodeIds.has(to)) return graph
  if (graph.edges.some((edge) => edge.from === from && edge.to === to && edge.lane === undefined)) return graph
  const taken = new Set(graph.edges.map((edge) => edge.id))
  const id = uniqueGraphId(`${from}-${to}`, taken)
  return {
    ...graph,
    edges: [...graph.edges, { id, from, to, kind: "sequence" }],
    layout: MANUAL_LAYOUT,
  }
}

export function removeNode(graph: WorkflowGraphDraft, nodeId: string): WorkflowGraphDraft {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!node || node.type === "trigger") return graph
  return {
    ...graph,
    nodes: graph.nodes.filter((candidate) => candidate.id !== nodeId),
    edges: graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    layout: MANUAL_LAYOUT,
  }
}

export function removeEdge(graph: WorkflowGraphDraft, edgeId: string): WorkflowGraphDraft {
  if (!graph.edges.some((edge) => edge.id === edgeId)) return graph
  return {
    ...graph,
    edges: graph.edges.filter((edge) => edge.id !== edgeId),
    layout: MANUAL_LAYOUT,
  }
}

export function addNode(graph: WorkflowGraphDraft, type: WorkflowNodeWire["type"]): WorkflowGraphDraft {
  if (type === "trigger") return graph
  const taken = new Set(graph.nodes.map((node) => node.id))
  const stem = type === "gate" ? "approval" : type
  const id = uniqueGraphId(stem, taken)
  const right = graph.nodes.reduce((max, node) => Math.max(max, node.position.x), 0)
  const top = graph.nodes.length > 0
    ? graph.nodes.reduce((sum, node) => sum + node.position.y, 0) / graph.nodes.length
    : 100
  const base: WorkflowNodeWire = {
    id,
    type,
    label: type === "gate" ? "Approval" : type === "step" ? "New step" : type === "switch" ? "Switch" : type === "wait" ? "Wait" : "Fail",
    position: { x: snapToGrid(right + 320), y: snapToGrid(top) },
  }
  const node: WorkflowNodeWire = type === "gate"
    ? { ...base, gate: { kind: "approval", description: "Approve this step", approvalRef: id } }
    : type === "switch"
      ? { ...base, switchMode: "firstMatch" }
      : type === "wait"
        ? { ...base, waitMinutes: 5 }
        : type === "fail"
          ? { ...base, failMessage: "Workflow stopped." }
          : base
  return { ...graph, nodes: [...graph.nodes, node], layout: MANUAL_LAYOUT }
}

/** Graph dirty is deliberately geometry/topology-only. Property drafts have
 * their existing comparator, while provenance alone never creates a phantom
 * edit on older definitions that predate layout metadata. */
export function isGraphDirty(definition: EditableWorkflowDefinitionWire, graph: WorkflowGraphDraft): boolean {
  const persistedNodes = definition.nodes.map(({ id, type, position }) => ({ id, type, position }))
  const draftedNodes = graph.nodes.map(({ id, type, position }) => ({ id, type, position }))
  return canonical(persistedNodes) !== canonical(draftedNodes) || canonical(definition.edges) !== canonical(graph.edges)
}

/** True if any draft diverges from the definition's persisted values. */
export function isDirty(def: EditableWorkflowDefinitionWire, drafts: Record<string, NodeDraft>): boolean {
  const edgeById = new Map(def.edges.map((e) => [e.id, e]))
  return def.nodes.some((n) => {
    const d = drafts[n.id]
    if (!d) return false
    if (d.label !== n.label || d.cadence !== (n.cadence ?? "") || d.instructions !== (n.instructions ?? "")) return true
    // Switch/fail fields (GRS-016c). Branch rules compare ENCODED vs the persisted
    // out-edge `when`, same canonical treatment as options.
    if (n.type === "switch") {
      if ((d.switchMode ?? "") !== (n.switchMode ?? "")) return true
      return (d.branches ?? []).some((b) => {
        const persisted = edgeById.get(b.edgeId)?.when ?? null
        return canonical(conditionsFromRows(b.rows) ?? null) !== canonical(persisted)
      })
    }
    if (n.type === "fail") return (d.failMessage ?? "") !== (n.failMessage ?? "")
    // Wait fields (GRS-016d): string-drafted, "" = unset.
    if (n.type === "wait") {
      return (
        (d.waitMinutes ?? "") !== (n.waitMinutes !== undefined ? String(n.waitMinutes) : "") ||
        (d.waitUntil ?? "") !== (n.waitUntil ?? "")
      )
    }
    // Options (GRS-016b): compare the ENCODED form, key-order-insensitively, so a
    // representation difference (draft field order vs file order) can't read as an edit.
    if (n.type !== "step") return false
    if (canonical(optionsFromDraft(d) ?? null) !== canonical(n.options ?? null)) return true
    // Error-lane markers (GRS-016d) live on the step's out-edges. Compare the
    // EFFECTIVE encoding (lanes are neutralized when the draft's onError is not
    // 'error-edge' — GRS-016d-fix), so dirty always agrees with buildEdgesPatch.
    const laneMode = d.onError === "error-edge"
    return (d.errorLanes ?? []).some((l) => {
      const persisted = edgeById.get(l.edgeId)?.lane === "error"
      return (laneMode && l.error) !== persisted
    })
  })
}

/** Build the shallow PUT patch: the full node array with drafts applied. The
 * store does a shallow merge, so replacing `nodes` wholesale is the canvas-save
 * semantic. Empty cadence is dropped back to `undefined` (matches the schema's
 * optional field; avoids persisting "" where the source had none). */
export function buildNodesPatch(
  def: EditableWorkflowDefinitionWire,
  drafts: Record<string, NodeDraft>,
): WorkflowNodeWire[] {
  return def.nodes.map((n) => {
    const d = drafts[n.id]
    if (!d) return n
    const label = d.label
    const cadence = d.cadence.trim() === "" ? undefined : d.cadence
    const next: WorkflowNodeWire = { ...n, label }
    if (cadence === undefined) delete next.cadence
    else next.cadence = cadence
    // `instructions` is a STEP-only field (the validator rejects it elsewhere);
    // empty drops back to undefined like cadence.
    if (n.type === "step") {
      const instructions = d.instructions.trim() === "" ? undefined : d.instructions
      if (instructions === undefined) delete next.instructions
      else next.instructions = instructions
      // `options` (GRS-016b): step-only; an all-empty draft drops the key entirely.
      // When the encoded draft equals the persisted options (key order aside), keep
      // the persisted object — a no-op edit must not churn the file's key order.
      const options = optionsFromDraft(d)
      if (options === undefined) delete next.options
      else if (n.options && canonical(options) === canonical(n.options)) next.options = n.options
      else next.options = options
    }
    // GRS-016c: switchMode (switch-only, "" = firstMatch default → key dropped);
    // failMessage (fail-only; empty drops the key — the server validator then
    // surfaces "fail node needs a message" rather than persisting "").
    if (n.type === "switch") {
      const mode = (d.switchMode ?? "").trim()
      if (mode === "") delete next.switchMode
      else next.switchMode = mode as WorkflowNodeWire["switchMode"]
    }
    if (n.type === "fail") {
      const message = (d.failMessage ?? "").trim() === "" ? undefined : d.failMessage
      if (message === undefined) delete next.failMessage
      else next.failMessage = message
    }
    // GRS-016d wait node: string drafts re-encode ("" drops the key; the server
    // validator enforces exactly-one-of + bounds, surfaced inline like the rest).
    if (n.type === "wait") {
      const minutes = (d.waitMinutes ?? "").trim()
      if (minutes === "") delete next.waitMinutes
      else next.waitMinutes = Number(minutes)
      const until = (d.waitUntil ?? "").trim()
      if (until === "") delete next.waitUntil
      else next.waitUntil = until
    }
    return next
  })
}

/** Build the edges half of the PUT patch: switch out-edge `when` arrays re-encoded
 * from the branch drafts (GRS-016c) and step out-edge `lane` markers from the
 * error-lane drafts (GRS-016d — an edge belongs to at most ONE source node, so the
 * two edits can never collide). Untouched edges keep their persisted objects — a
 * no-op save must not churn file key order. */
export function buildEdgesPatch(
  def: EditableWorkflowDefinitionWire,
  drafts: Record<string, NodeDraft>,
): WorkflowEdgeWire[] {
  const rowsByEdge = new Map<string, ConditionRowDraft[]>()
  const laneByEdge = new Map<string, boolean>()
  for (const n of def.nodes) {
    if (n.type === "switch") {
      for (const b of drafts[n.id]?.branches ?? []) rowsByEdge.set(b.edgeId, b.rows)
    }
    if (n.type === "step") {
      // GRS-016d-fix (Codex finding 2): a lane is a SUB-SETTING of onError:
      // 'error-edge'. When the draft's mode is anything else, every lane for this
      // source encodes as OFF in the same save — the checkbox UI is hidden then,
      // so a stale persisted lane would otherwise be unreachable state that
      // 400-rejects every subsequent save (misplaced-edge-lane).
      const laneMode = drafts[n.id]?.onError === "error-edge"
      for (const l of drafts[n.id]?.errorLanes ?? []) laneByEdge.set(l.edgeId, laneMode && l.error)
    }
  }
  return def.edges.map((e) => {
    let next = e
    const rows = rowsByEdge.get(e.id)
    if (rows !== undefined) {
      const encoded = conditionsFromRows(rows)
      if (encoded === undefined) {
        if (e.when !== undefined) {
          next = { ...next }
          delete next.when
        }
      } else if (!(e.when && canonical(encoded) === canonical(e.when))) {
        next = { ...next, when: encoded }
      }
    }
    const lane = laneByEdge.get(e.id)
    if (lane !== undefined) {
      const persisted = e.lane === "error"
      if (lane && !persisted) next = { ...next, lane: "error" }
      else if (!lane && e.lane !== undefined) {
        next = { ...next }
        delete next.lane
      }
    }
    return next
  })
}

/* ── Editable inspector ───────────────────────────────────────────────────── */

const OPT_LABEL =
  "mb-1 block text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]"
const OPT_INPUT =
  "w-full rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg)] px-2 py-1.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)]"

const ROLE_TINT: Record<string, string> = {
  trigger: "var(--system-purple)",
  gate: "var(--system-yellow)",
  switch: "var(--system-blue)",
  fail: "var(--system-red)",
  wait: "var(--system-orange)",
  orchestrate: "var(--system-blue)",
  implement: "var(--system-blue)",
  verify: "var(--system-green)",
  adversary: "var(--system-orange)",
  steer: "var(--system-purple)",
  qa: "var(--system-green)",
  decide: "var(--system-blue)",
  package: "var(--text-tertiary)",
}

const WAKE_UP_KIND_CHOICES: Array<{ kind: WakeUpKind; label: string; icon: typeof Play }> = [
  { kind: "manual", label: "Manual", icon: Play },
  { kind: "schedule", label: "Schedule", icon: Clock },
  { kind: "todo-status", label: "Todo status", icon: ListChecks },
  { kind: "event", label: "Event", icon: Radio },
  { kind: "poll", label: "Poll", icon: RefreshCw },
]

function WakeUpEditor({
  draft,
  loadError,
  onChange,
}: {
  draft: WakeUpDraft
  loadError: string | null
  onChange: (patch: Partial<WakeUpDraft>) => void
}) {
  return (
    <section
      data-testid="wf-wakeup-editor"
      className="mx-[var(--space-4)] mt-[var(--space-3)] rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-[var(--space-3)] shadow-[var(--shadow-subtle)]"
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase text-[var(--text-tertiary)]">
            Wake-up
          </div>
          <h2 className="mt-0.5 text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            When this happens
          </h2>
        </div>
        {loadError && (
          <div className="rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-orange)_12%,transparent)] px-2.5 py-1.5 text-[length:var(--text-caption1)] text-[var(--system-orange)]">
            {loadError}
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-1 sm:grid-cols-5">
        {WAKE_UP_KIND_CHOICES.map(({ kind, label, icon: Icon }) => {
          const active = draft.kind === kind
          return (
            <button
              key={kind}
              type="button"
              data-testid={`wf-wakeup-${kind}`}
              onClick={() => onChange({ kind })}
              className="flex h-10 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] transition-colors"
              style={{
                background: active ? "var(--bg)" : "transparent",
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                boxShadow: active ? "var(--shadow-subtle)" : "none",
              }}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-3">
        {draft.kind === "manual" && (
          <div className="rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] px-3 py-2 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
            Starts only from an operator command.
          </div>
        )}

        {draft.kind === "schedule" && (
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px]">
            <label>
              <span className={OPT_LABEL}>Cron</span>
              <input
                data-testid="wf-wakeup-cron"
                className="apple-input w-full font-mono text-[length:var(--text-subheadline)]"
                value={draft.cron}
                placeholder="0 9 * * 1-5"
                onChange={(e) => onChange({ cron: e.target.value })}
              />
            </label>
            <label>
              <span className={OPT_LABEL}>Timezone</span>
              <input
                data-testid="wf-wakeup-timezone"
                className="apple-input w-full text-[length:var(--text-subheadline)]"
                value={draft.timezone}
                placeholder="UTC"
                onChange={(e) => onChange({ timezone: e.target.value })}
              />
            </label>
          </div>
        )}

        {draft.kind === "todo-status" && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              <span className={OPT_LABEL}>To status</span>
              <select
                data-testid="wf-wakeup-to-status"
                className="apple-input w-full text-[length:var(--text-subheadline)]"
                value={draft.toStatus}
                onChange={(e) => onChange({ toStatus: e.target.value })}
              >
                {TODO_STATUS_CHOICES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label>
              <span className={OPT_LABEL}>From status</span>
              <select
                data-testid="wf-wakeup-from-status"
                className="apple-input w-full text-[length:var(--text-subheadline)]"
                value={draft.fromStatus}
                onChange={(e) => onChange({ fromStatus: e.target.value })}
              >
                <option value="">any</option>
                {TODO_STATUS_CHOICES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label>
              <span className={OPT_LABEL}>Assignee</span>
              <input
                data-testid="wf-wakeup-filter-assignee"
                className="apple-input w-full text-[length:var(--text-subheadline)]"
                value={draft.filterAssignee}
                placeholder="any"
                onChange={(e) => onChange({ filterAssignee: e.target.value })}
              />
            </label>
            <label>
              <span className={OPT_LABEL}>Department</span>
              <input
                data-testid="wf-wakeup-filter-department"
                className="apple-input w-full text-[length:var(--text-subheadline)]"
                value={draft.filterDepartment}
                placeholder="any"
                onChange={(e) => onChange({ filterDepartment: e.target.value })}
              />
            </label>
          </div>
        )}

        {(draft.kind === "event" || draft.kind === "poll") && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              <span className={OPT_LABEL}>Binding name</span>
              <input
                data-testid="wf-wakeup-trigger-name"
                className="apple-input w-full text-[length:var(--text-subheadline)]"
                value={draft.triggerName}
                placeholder={draft.kind === "poll" ? "daily-check" : "lead-hook"}
                onChange={(e) => onChange({ triggerName: e.target.value })}
              />
            </label>
            <label>
              <span className={OPT_LABEL}>Event</span>
              <input
                data-testid="wf-wakeup-event-name"
                className="apple-input w-full text-[length:var(--text-subheadline)]"
                value={draft.eventName}
                placeholder={draft.kind === "poll" ? "check.ready" : "lead.created"}
                onChange={(e) => onChange({ eventName: e.target.value })}
              />
            </label>
            {draft.kind === "event" ? (
              <label className="sm:col-span-2">
                <span className={OPT_LABEL}>Secret</span>
                <input
                  data-testid="wf-wakeup-secret"
                  className="apple-input w-full text-[length:var(--text-subheadline)]"
                  value={draft.secretToken}
                  placeholder="leave blank to keep generated secret"
                  onChange={(e) => onChange({ secretToken: e.target.value })}
                />
              </label>
            ) : (
              <>
                <label>
                  <span className={OPT_LABEL}>Command</span>
                  <input
                    data-testid="wf-wakeup-command"
                    className="apple-input w-full text-[length:var(--text-subheadline)]"
                    value={draft.command}
                    placeholder="node scripts/check.js"
                    onChange={(e) => onChange({ command: e.target.value })}
                  />
                </label>
                <label>
                  <span className={OPT_LABEL}>Seconds</span>
                  <input
                    data-testid="wf-wakeup-interval"
                    type="number"
                    min={1}
                    className="apple-input w-full text-[length:var(--text-subheadline)]"
                    value={draft.intervalSeconds}
                    onChange={(e) => onChange({ intervalSeconds: e.target.value })}
                  />
                </label>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

export function EditableNodeInspector({
  node,
  draft,
  fieldErrors,
  onChange,
  onClose,
  onRemove,
}: {
  node: CanvasNode
  draft: NodeDraft
  fieldErrors?: WorkflowValidationError[]
  onChange: (patch: Partial<NodeDraft>) => void
  onClose: () => void
  onRemove?: () => void
}) {
  const tint = ROLE_TINT[node.role] ?? "var(--text-tertiary)"
  const labelBlank = draft.label.trim() === ""
  return (
    <div
      data-testid="wf-edit-inspector"
      className="flex h-full flex-col border-[var(--separator)] bg-[var(--bg-secondary)]"
    >
      <div className="flex items-start justify-between gap-2 border-b border-[var(--separator)] p-[var(--space-4)]">
        <div className="min-w-0">
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-[var(--weight-semibold)] uppercase tracking-wide"
            style={{ background: `color-mix(in srgb, ${tint} 15%, transparent)`, color: tint }}
          >
            {node.role}
          </span>
          <h2 className="mt-1.5 text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            Edit node
          </h2>
          <div className="mt-0.5 font-mono text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">{node.id}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="rounded-[var(--radius-sm)] p-1 text-[var(--text-tertiary)] hover:bg-[var(--fill-quaternary)]"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-[var(--space-4)]">
        <label className="block">
          <span className="mb-1 block text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
            Label
          </span>
          <input
            data-testid="wf-edit-label"
            type="text"
            value={draft.label}
            onChange={(e) => onChange({ label: e.target.value })}
            className="w-full rounded-[var(--radius-sm)] border bg-[var(--bg)] px-2 py-1.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)]"
            style={{ borderColor: labelBlank ? "var(--system-red)" : "var(--separator)" }}
          />
          {labelBlank && (
            <span className="mt-1 block text-[length:var(--text-caption2)] text-[var(--system-red)]">
              Label can’t be empty.
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
            Cadence <span className="normal-case text-[var(--text-tertiary)]">(optional)</span>
          </span>
          <input
            data-testid="wf-edit-cadence"
            type="text"
            value={draft.cadence}
            placeholder="e.g. once daily"
            onChange={(e) => onChange({ cadence: e.target.value })}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg)] px-2 py-1.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)]"
          />
        </label>

        {node.kind === "step" && (
          <label className="block">
            <span className="mb-1 block text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
              Instructions <span className="normal-case text-[var(--text-tertiary)]">(optional — the step's task)</span>
            </span>
            <textarea
              data-testid="wf-edit-instructions"
              value={draft.instructions}
              rows={5}
              placeholder="What should the spawned session actually do? This becomes the step prompt's task section."
              onChange={(e) => onChange({ instructions: e.target.value })}
              className="w-full resize-y rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg)] px-2 py-1.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)]"
            />
          </label>
        )}

        {/* GRS-016b engine-node options — plain controls (the polished pickers are
            GRS-016f). Only for actor-bearing steps: the validator refuses options on
            inline steps (they spawn nothing), and `who === "—"` is the actorless
            marker nodesForDefinition renders. */}
        {node.kind === "step" && node.who !== "—" && (
          <fieldset data-testid="wf-edit-options" className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--separator)] p-2.5">
            <legend className="px-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
              Execution options
            </legend>

            <label className="block">
              <span className={OPT_LABEL}>Model override <span className="normal-case">(blank = actor default)</span></span>
              <input
                data-testid="wf-edit-opt-model"
                type="text"
                value={draft.model ?? ""}
                placeholder="e.g. opus, gpt-5.5"
                onChange={(e) => onChange({ model: e.target.value })}
                className={OPT_INPUT}
              />
            </label>

            <label className="block">
              <span className={OPT_LABEL}>Effort override</span>
              <select
                data-testid="wf-edit-opt-effort"
                value={draft.effort ?? ""}
                onChange={(e) => onChange({ effort: e.target.value })}
                className={OPT_INPUT}
              >
                <option value="">default</option>
                {EFFORT_CHOICES.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
              </select>
            </label>

            <label className="block">
              <span className={OPT_LABEL}>Output to successors</span>
              <select
                data-testid="wf-edit-opt-output"
                value={draft.output ?? ""}
                onChange={(e) => onChange({ output: e.target.value })}
                className={OPT_INPUT}
              >
                <option value="">handoff (default — declared summary block)</option>
                <option value="full">full — the entire final message</option>
                <option value="none">none — fire-and-forget (spawned, never awaited)</option>
              </select>
            </label>

            <label className="block">
              <span className={OPT_LABEL}>On error</span>
              <select
                data-testid="wf-edit-opt-onerror"
                value={draft.onError ?? ""}
                onChange={(e) => onChange({ onError: e.target.value })}
                className={OPT_INPUT}
              >
                <option value="">fail run (default)</option>
                <option value="continue">continue — record failed, keep going</option>
                <option value="error-edge">error-edge — route failure down the error lane</option>
              </select>
            </label>

            {/* GRS-016d: error-lane markers per out-edge — shown only when the
                failure route is declared (lane elsewhere is a validation error). */}
            {draft.onError === "error-edge" && (
              <div data-testid="wf-edit-error-lanes">
                <span className={OPT_LABEL}>Error lane — which out-edge takes the failure</span>
                {(draft.errorLanes ?? []).length === 0 && (
                  <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                    This node has no out-edges — error-edge needs one to route to.
                  </div>
                )}
                {(draft.errorLanes ?? []).map((laneRow, li) => (
                  <label key={laneRow.edgeId} className="mt-1 flex items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                    <input
                      data-testid={`wf-edit-lane-${laneRow.edgeId}`}
                      type="checkbox"
                      checked={laneRow.error}
                      onChange={() =>
                        onChange({
                          errorLanes: (draft.errorLanes ?? []).map((l, i) =>
                            i === li ? { ...l, error: !l.error } : l,
                          ),
                        })
                      }
                    />
                    → {laneRow.to}
                    <span className="font-mono text-[10px] text-[var(--text-tertiary)]">{laneRow.edgeId}</span>
                  </label>
                ))}
              </div>
            )}

            <div>
              <label className="block">
                <span className={OPT_LABEL}>Retry — max attempts <span className="normal-case">(blank = respawn-once on interruption)</span></span>
                <input
                  data-testid="wf-edit-opt-retry-max"
                  type="number"
                  min={1}
                  max={5}
                  value={draft.retryMaxAttempts ?? ""}
                  onChange={(e) => onChange({ retryMaxAttempts: e.target.value })}
                  className={OPT_INPUT}
                />
              </label>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {RETRY_CAUSE_CHOICES.map((cause) => (
                  <label key={cause} className="flex items-center gap-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                    <input
                      data-testid={`wf-edit-opt-retry-${cause}`}
                      type="checkbox"
                      checked={(draft.retryOn ?? []).includes(cause)}
                      onChange={() =>
                        onChange({
                          retryOn: (draft.retryOn ?? []).includes(cause)
                            ? (draft.retryOn ?? []).filter((c) => c !== cause)
                            : [...(draft.retryOn ?? []), cause],
                        })
                      }
                    />
                    {cause}
                  </label>
                ))}
              </div>
            </div>

            <label className="block">
              <span className={OPT_LABEL}>Timeout minutes <span className="normal-case">(blank = unbounded; on breach the session is stopped)</span></span>
              <input
                data-testid="wf-edit-opt-timeout"
                type="number"
                min={1}
                max={10080}
                value={draft.timeoutMinutes ?? ""}
                onChange={(e) => onChange({ timeoutMinutes: e.target.value })}
                className={OPT_INPUT}
              />
            </label>

            {/* GRS-016e session mode — where this node's turn runs. 'existing' is
                the risky brick (operator ruling: ship it LABELED): the id field and
                the live-session warning render only when it is chosen. */}
            <label className="block">
              <span className={OPT_LABEL}>Session</span>
              <select
                data-testid="wf-edit-opt-session-mode"
                value={draft.sessionMode ?? ""}
                onChange={(e) => onChange({ sessionMode: e.target.value })}
                className={OPT_INPUT}
              >
                <option value="">fresh (default — a new session each time this node runs)</option>
                <option value="workflow">this workflow — continue the run&apos;s ONE shared session</option>
                <option value="existing">existing session — message a specific live session</option>
              </select>
            </label>
            {draft.sessionMode === "existing" && (
              <label className="block">
                <span className={OPT_LABEL}>Target session id</span>
                <input
                  data-testid="wf-edit-opt-session-id"
                  type="text"
                  value={draft.sessionId ?? ""}
                  placeholder="a live gateway session id (a picker lands with GRS-016f)"
                  onChange={(e) => onChange({ sessionId: e.target.value })}
                  className={OPT_INPUT}
                />
                <span
                  data-testid="wf-edit-session-warning"
                  className="mt-1 block text-[length:var(--text-caption2)] text-[var(--system-orange)]"
                >
                  ⚠ The workflow will message this LIVE session — its step prompt lands as the next turn
                  of that conversation, and the reply becomes the step&apos;s outcome. Anyone using that
                  session will see (and share) the workflow&apos;s turn.
                </span>
              </label>
            )}
          </fieldset>
        )}

        {/* GRS-016c fail node: the authored stop-and-error message. */}
        {node.kind === "fail" && (
          <label className="block">
            <span className={OPT_LABEL}>Fail message <span className="normal-case">(required — becomes the run error)</span></span>
            <textarea
              data-testid="wf-edit-fail-message"
              value={draft.failMessage ?? ""}
              rows={3}
              placeholder="Why does reaching this node fail the run?"
              onChange={(e) => onChange({ failMessage: e.target.value })}
              className={`${OPT_INPUT} resize-y`}
            />
          </label>
        )}

        {/* GRS-016d wait node: duration OR absolute deadline (exactly one — the
            server validator enforces it and errors render inline below). */}
        {node.kind === "wait" && (
          <fieldset data-testid="wf-edit-wait" className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--separator)] p-2.5">
            <legend className="px-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
              Pause
            </legend>
            <label className="block">
              <span className={OPT_LABEL}>Wait minutes <span className="normal-case">(1–10080; the 15s sweep is the clock)</span></span>
              <input
                data-testid="wf-edit-wait-minutes"
                type="number"
                min={1}
                max={10080}
                value={draft.waitMinutes ?? ""}
                onChange={(e) => onChange({ waitMinutes: e.target.value })}
                className={OPT_INPUT}
              />
            </label>
            <label className="block">
              <span className={OPT_LABEL}>…or wait until <span className="normal-case">(ISO time, e.g. 2026-07-06T09:00:00Z)</span></span>
              <input
                data-testid="wf-edit-wait-until"
                type="text"
                value={draft.waitUntil ?? ""}
                placeholder="YYYY-MM-DDTHH:mm:ssZ"
                onChange={(e) => onChange({ waitUntil: e.target.value })}
                className={`${OPT_INPUT} font-mono text-[11px]`}
              />
            </label>
            <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
              Declare one of the two. The deadline persists on the run, so it survives a gateway restart.
            </div>
          </fieldset>
        )}

        {/* GRS-016c switch node: evaluation mode + per-out-edge condition rules
            (plain controls; the polished path picker is GRS-016f). */}
        {node.kind === "switch" && (
          <fieldset data-testid="wf-edit-switch" className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--separator)] p-2.5">
            <legend className="px-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-wide text-[var(--text-tertiary)]">
              Routing
            </legend>
            <label className="block">
              <span className={OPT_LABEL}>Mode</span>
              <select
                data-testid="wf-edit-switch-mode"
                value={draft.switchMode ?? ""}
                onChange={(e) => onChange({ switchMode: e.target.value })}
                className={OPT_INPUT}
              >
                <option value="">firstMatch (default — first passing rule wins)</option>
                <option value="firstMatch">firstMatch</option>
                <option value="allMatches">allMatches — every passing rule activates</option>
              </select>
            </label>
            {(draft.branches ?? []).map((branch, bi) => {
              const patchBranch = (rows: ConditionRowDraft[]) =>
                onChange({
                  branches: (draft.branches ?? []).map((b, i) => (i === bi ? { ...b, rows } : b)),
                })
              return (
                <div key={branch.edgeId} className="rounded-[var(--radius-sm)] border border-[var(--separator)] p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-secondary)]">
                      → {branch.to}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--text-tertiary)]">{branch.edgeId}</span>
                  </div>
                  {branch.rows.length === 0 && (
                    <div data-testid={`wf-edit-branch-${branch.edgeId}-default`} className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                      Default branch — taken when no rule matches.
                    </div>
                  )}
                  {branch.rows.map((row, ri) => {
                    const patchRow = (p: Partial<ConditionRowDraft>) =>
                      patchBranch(branch.rows.map((r, i) => (i === ri ? { ...r, ...p } : r)))
                    const valueless = row.op === "exists" || row.op === "absent"
                    return (
                      <div key={ri} className="mt-1.5 space-y-1">
                        <input
                          data-testid={`wf-edit-cond-${branch.edgeId}-${ri}-path`}
                          type="text"
                          value={row.path}
                          placeholder="steps.<node>.outcome.fields.<key>"
                          onChange={(e) => patchRow({ path: e.target.value })}
                          className={`${OPT_INPUT} font-mono text-[11px]`}
                        />
                        <div className="flex items-center gap-1">
                          <select
                            data-testid={`wf-edit-cond-${branch.edgeId}-${ri}-op`}
                            value={row.op}
                            onChange={(e) => patchRow({ op: e.target.value })}
                            className={OPT_INPUT}
                          >
                            {CONDITION_OP_CHOICES.map((op) => <option key={op} value={op}>{op}</option>)}
                          </select>
                          {!valueless && (
                            <>
                              <input
                                data-testid={`wf-edit-cond-${branch.edgeId}-${ri}-value`}
                                type="text"
                                value={row.value}
                                placeholder="value"
                                onChange={(e) => patchRow({ value: e.target.value })}
                                className={OPT_INPUT}
                              />
                              <select
                                data-testid={`wf-edit-cond-${branch.edgeId}-${ri}-type`}
                                value={row.valueType}
                                onChange={(e) => patchRow({ valueType: e.target.value as ConditionRowDraft["valueType"] })}
                                className={OPT_INPUT}
                                aria-label="value type"
                              >
                                <option value="string">str</option>
                                <option value="number">num</option>
                                <option value="boolean">bool</option>
                              </select>
                            </>
                          )}
                          <button
                            type="button"
                            data-testid={`wf-edit-cond-${branch.edgeId}-${ri}-remove`}
                            aria-label="Remove condition"
                            onClick={() => patchBranch(branch.rows.filter((_, i) => i !== ri))}
                            className="rounded-[var(--radius-sm)] px-1.5 py-1 text-[var(--text-tertiary)] hover:bg-[var(--fill-quaternary)]"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  <button
                    type="button"
                    data-testid={`wf-edit-branch-${branch.edgeId}-add`}
                    onClick={() => patchBranch([...branch.rows, { path: "", op: "eq", value: "", valueType: "string" }])}
                    className="mt-1.5 text-[length:var(--text-caption2)] text-[var(--accent)] hover:underline"
                  >
                    + add condition
                  </button>
                </div>
              )
            })}
            <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
              Rules are AND within a branch, evaluated in edge order. Paths: steps.&lt;node&gt;.status ·
              steps.&lt;node&gt;.outcome.fields.&lt;key&gt; · run.rounds · run.status · trigger.source · trigger.event · trigger.payload.&lt;key&gt;.
            </div>
          </fieldset>
        )}

        {fieldErrors && fieldErrors.length > 0 && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--system-red)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] p-2">
            {fieldErrors.map((e, i) => (
              <div key={i} className="text-[length:var(--text-caption1)] text-[var(--system-red)]">
                {e.path ? `${e.path}: ` : ""}
                {e.message}
              </div>
            ))}
          </div>
        )}

        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--system-red)] transition-colors hover:bg-[color-mix(in_srgb,var(--system-red)_9%,transparent)]"
          >
            <Trash2 className="size-4" />
            Remove step
          </button>
        )}

        <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          Editing changes the workflow definition, not any past run. Save writes a new version.
        </div>
      </div>
    </div>
  )
}

/* ── Edit view container ──────────────────────────────────────────────────── */

export function WorkflowEditView({
  workflowId,
  onDirtyChange,
  onLeaveActionsChange,
}: {
  workflowId: string
  /** Reports unsaved-changes state up so the parent can guard mode switches. */
  onDirtyChange?: (dirty: boolean) => void
  /** Gives the route guard the editor's real save/discard operations. */
  onLeaveActionsChange?: (actions: { save: () => Promise<boolean>; discard: () => void } | null) => void
}) {
  const [def, setDef] = useState<EditableWorkflowDefinitionWire | null>(null)
  const [drafts, setDrafts] = useState<Record<string, NodeDraft>>({})
  const [graph, setGraph] = useState<WorkflowGraphDraft | null>(null)
  const [layoutPreview, setLayoutPreview] = useState<WorkflowGraphDraft | null>(null)
  const [tidying, setTidying] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<{ message: string; errors?: WorkflowValidationError[] } | null>(null)
  const [savedTick, setSavedTick] = useState(0)
  const [triggerBindings, setTriggerBindings] = useState<WorkflowTriggerBindingWire[]>([])
  const [triggerLoadError, setTriggerLoadError] = useState<string | null>(null)
  const [triggerApprovalError, setTriggerApprovalError] = useState<string | null>(null)
  const [triggerApprovalBusy, setTriggerApprovalBusy] = useState(false)
  const [wakeUpDraft, setWakeUpDraft] = useState<WakeUpDraft>(EMPTY_WAKE_UP)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.allSettled([
      api.getWorkflowDefinition(workflowId),
      api.listWorkflowTriggers(),
    ])
      .then(([definitionResult, triggerResult]) => {
        if (definitionResult.status === "rejected") {
          throw definitionResult.reason
        }
        const d = definitionResult.value
        let bindings: WorkflowTriggerBindingWire[] = []
        if (triggerResult.status === "fulfilled") {
          bindings = triggerResult.value.triggers.filter((b) => b.targetWorkflowId === d.id)
          setTriggerLoadError(triggerResult.value.evidenceConfigured ? null : "Wake-up bindings are unavailable until workflow evidence is configured.")
        } else {
          setTriggerLoadError("Wake-up bindings are unavailable in this gateway build.")
        }
        setDef(d)
        setDrafts(draftsFromDefinition(d))
        setGraph(graphFromDefinition(d))
        setLayoutPreview(null)
        setTriggerBindings(bindings)
        setWakeUpDraft(wakeUpDraftFromDefinition(d, bindings))
        setSelectedNodeId(null)
        setSaveError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load definition"))
      .finally(() => setLoading(false))
  }, [workflowId])

  useEffect(() => { load() }, [load])

  const nodeDirty = useMemo(() => (def ? isDirty(def, drafts) : false), [def, drafts])
  const triggerDirty = useMemo(
    () => (def ? wakeUpDirty(def, triggerBindings, wakeUpDraft) : false),
    [def, triggerBindings, wakeUpDraft],
  )
  const graphDirty = useMemo(() => (def && graph ? isGraphDirty(def, graph) : false), [def, graph])
  const dirty = nodeDirty || graphDirty || triggerDirty
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  const nodes = useMemo(() => {
    if (!def || !graph) return []
    const visibleGraph = layoutPreview ?? graph
    const visibleDefinition = { ...def, nodes: visibleGraph.nodes, edges: visibleGraph.edges }
    const built = nodesForDefinition(visibleDefinition, drafts)
    const ghost = ghostNodeForDefinition(visibleDefinition)
    return ghost ? [...built, ghost] : built
  }, [def, graph, layoutPreview, drafts])
  const canvasEdges = useMemo(() => {
    if (!def || !graph) return []
    const visibleGraph = layoutPreview ?? graph
    return edgesForDefinition({ ...def, nodes: visibleGraph.nodes, edges: visibleGraph.edges })
  }, [def, graph, layoutPreview])
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const activeTriggerBinding = def ? activeTriggerBindingFor(def.id, triggerBindings) : null

  const onNodeDraftChange = useCallback(
    (id: string, patch: Partial<NodeDraft>) => {
      setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
      setLayoutPreview(null)
      setSaveError(null)
    },
    [],
  )

  const onWakeUpDraftChange = useCallback((patch: Partial<WakeUpDraft>) => {
    setWakeUpDraft((prev) => ({ ...prev, ...patch }))
    setLayoutPreview(null)
    setSaveError(null)
  }, [])

  const decidePollActivation = useCallback(async (decision: "approve" | "reject") => {
    if (!activeTriggerBinding || activeTriggerBinding.kind !== "poll" || triggerApprovalBusy) return
    setTriggerApprovalBusy(true)
    setTriggerApprovalError(null)
    try {
      const { trigger } = await api.decideWorkflowTriggerActivationApproval(activeTriggerBinding.name, decision)
      setTriggerBindings((current) => current.map((binding) => binding.name === trigger.name ? trigger : binding))
    } catch (err) {
      setTriggerApprovalError(err instanceof Error ? err.message : "Approval decision failed")
    } finally {
      setTriggerApprovalBusy(false)
    }
  }, [activeTriggerBinding, triggerApprovalBusy])

  const anyLabelBlank = useMemo(
    () => Object.values(drafts).some((d) => d.label.trim() === ""),
    [drafts],
  )

  const save = useCallback(async () => {
    if (!def || !graph || saving) return false
    setSaving(true)
    setSaveError(null)
    const graphDefinition: EditableWorkflowDefinitionWire = {
      ...def,
      nodes: graph.nodes,
      edges: graph.edges,
    }
    const baseNodes = buildNodesPatch(graphDefinition, drafts)
    const patch = {
      nodes: triggerDirty ? buildWakeUpNodesPatch(graphDefinition, baseNodes, wakeUpDraft) : baseNodes,
      edges: buildEdgesPatch(graphDefinition, drafts),
    }
    try {
      const result = graphDirty
        ? await api.updateWorkflowDefinition(def.id, patch, def.version, { layoutIntent: "manual" })
        : await api.updateWorkflowDefinition(def.id, patch, def.version)
      if (result.ok) {
        const nextBindings = triggerDirty
          ? await saveWakeUpBindings(result.definition.id, triggerBindings, wakeUpDraft)
          : triggerBindings
        setDef(result.definition)
        setDrafts(draftsFromDefinition(result.definition))
        setGraph(graphFromDefinition(result.definition))
        setLayoutPreview(null)
        setTriggerBindings(nextBindings)
        setWakeUpDraft(wakeUpDraftFromDefinition(result.definition, nextBindings))
        setSavedTick((t) => t + 1)
        return true
      } else {
        setSaveError({ message: result.message, errors: result.errors })
        return false
      }
    } catch (e) {
      // authFetch can reject (offline/CORS) and res.json() can throw even on the
      // ok path — never leave the editor wedged with saving stuck true (Codex
      // GRS-011c-1 Major 2). Surface it as an inline error the operator can retry.
      setSaveError({ message: e instanceof Error ? e.message : "Save failed — check your connection and retry." })
      return false
    } finally {
      setSaving(false)
    }
  }, [def, graph, graphDirty, drafts, saving, triggerBindings, triggerDirty, wakeUpDraft])

  const discard = useCallback(() => {
    if (def) {
      setDrafts(draftsFromDefinition(def))
      setGraph(graphFromDefinition(def))
      setLayoutPreview(null)
      setWakeUpDraft(wakeUpDraftFromDefinition(def, triggerBindings))
    }
    setSaveError(null)
  }, [def, triggerBindings])

  useEffect(() => {
    onLeaveActionsChange?.({ save, discard })
    return () => onLeaveActionsChange?.(null)
  }, [discard, onLeaveActionsChange, save])

  const moveGraphNode = useCallback((nodeId: string, position: { x: number; y: number }) => {
    setGraph((current) => current ? moveNode(current, nodeId, position) : current)
    setLayoutPreview(null)
    setSaveError(null)
  }, [])

  const connectGraphNodes = useCallback((from: string, to: string) => {
    setGraph((current) => current ? connectNodes(current, from, to) : current)
    setLayoutPreview(null)
    setSaveError(null)
  }, [])

  const removeGraphNode = useCallback((nodeId: string) => {
    setGraph((current) => current ? removeNode(current, nodeId) : current)
    setDrafts((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })
    setSelectedNodeId((current) => current === nodeId ? null : current)
    setLayoutPreview(null)
    setSaveError(null)
  }, [])

  const removeGraphEdge = useCallback((edgeId: string) => {
    setGraph((current) => current ? removeEdge(current, edgeId) : current)
    setLayoutPreview(null)
    setSaveError(null)
  }, [])

  const addGraphNode = useCallback((type: WorkflowNodeWire["type"]) => {
    if (!def || !graph) return
    const next = addNode(graph, type)
    const added = next.nodes.find((node) => !graph.nodes.some((old) => old.id === node.id))
    if (!added) return
    setGraph(next)
    const one = draftsFromDefinition({ ...def, nodes: [added], edges: [] })[added.id]
    setDrafts((current) => ({ ...current, [added.id]: one }))
    setSelectedNodeId(added.id)
    setLayoutPreview(null)
    setAddOpen(false)
    setSaveError(null)
  }, [def, graph])

  const tidy = useCallback(async () => {
    if (!def || !graph || tidying) return
    setTidying(true)
    setSaveError(null)
    const { layout: _serverLayout, ...definitionWithoutLayout } = def
    const graphDefinition: EditableWorkflowDefinitionWire = {
      ...definitionWithoutLayout,
      nodes: buildNodesPatch({ ...def, nodes: graph.nodes, edges: graph.edges }, drafts),
      edges: buildEdgesPatch({ ...def, nodes: graph.nodes, edges: graph.edges }, drafts),
    }
    try {
      const planned = await api.planWorkflowDefinition(graphDefinition, { layoutIntent: "normalize" })
      setLayoutPreview(graphFromDefinition(planned.layout.normalizedPreview))
    } catch (e) {
      setSaveError({ message: e instanceof Error ? e.message : "Couldn’t plan this layout." })
    } finally {
      setTidying(false)
    }
  }, [def, graph, drafts, tidying])

  const applyLayout = useCallback(() => {
    if (!layoutPreview) return
    setGraph((current) => {
      if (!current) return current
      const previewPosition = new Map(layoutPreview.nodes.map((node) => [node.id, node.position]))
      return {
        ...current,
        nodes: current.nodes.map((node) => {
          const position = previewPosition.get(node.id)
          return position ? { ...node, position: { ...position } } : node
        }),
        layout: MANUAL_LAYOUT,
      }
    })
    setLayoutPreview(null)
  }, [layoutPreview])

  if (loading) {
    return <div className="flex h-40 items-center justify-center text-[var(--text-tertiary)]">Loading definition…</div>
  }
  if (error || !def) {
    return (
      <div className="m-[var(--space-4)] rounded-[var(--radius-md)] border border-[var(--system-red)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
        {error ?? "No definition."}
        <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          This workflow has no editable definition yet, or workflow storage is misconfigured on the gateway (check the logs, or the <code>JINN_WORKFLOW_EVIDENCE_ROOT</code> override if set).
        </div>
      </div>
    )
  }

  const saveDisabled = saving || !dirty || anyLabelBlank || !wakeUpValid(wakeUpDraft)

  return (
    <div className="flex h-full w-full flex-col">
      {/* Edit toolbar: version, dirty state, Save / Discard. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--separator)] px-[var(--space-4)] py-[var(--space-2)]">
        <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          Editing definition{" "}
          <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{def.title}</span>{" "}
          <span className="text-[var(--text-tertiary)]">· v{def.version} · {def.status}</span>
        </span>
        {dirty && (
          <span
            data-testid="wf-edit-dirty"
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)]"
            style={{ background: "color-mix(in srgb, var(--system-orange) 15%, transparent)", color: "var(--system-orange)" }}
          >
            unsaved changes
          </span>
        )}
        {savedTick > 0 && !dirty && (
          <span
            data-testid="wf-edit-saved"
            className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)]"
            style={{ color: "var(--system-green)" }}
          >
            saved ✓
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative">
            <button
              type="button"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((open) => !open)}
              className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
            >
              <Plus className="size-3.5" /> Add
            </button>
            {addOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-1 min-w-40 rounded-[var(--radius-lg)] bg-[var(--bg-tertiary)] p-1 shadow-[var(--shadow-overlay)]"
              >
                {([
                  ["step", "Step"],
                  ["gate", "Approval"],
                  ["switch", "Switch"],
                  ["wait", "Wait"],
                  ["fail", "Fail"],
                ] as const).map(([type, label]) => (
                  <button
                    key={type}
                    type="button"
                    role="menuitem"
                    onClick={() => addGraphNode(type)}
                    className="flex min-h-10 w-full items-center rounded-[var(--radius-md)] px-3 text-left text-[length:var(--text-subheadline)] text-[var(--text-primary)] transition-colors hover:bg-[var(--fill-secondary)]"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {layoutPreview && (
            <button
              type="button"
              onClick={applyLayout}
              className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent-fill)] px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--accent)] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              <Network className="size-3.5" /> Apply layout
            </button>
          )}
          <button
            type="button"
            onClick={discard}
            disabled={!dirty || saving}
            data-testid="wf-edit-discard"
            className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)] hover:bg-[var(--fill-quaternary)] disabled:opacity-40"
          >
            <RotateCcw className="size-3.5" />
            Discard
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saveDisabled}
            data-testid="wf-edit-save"
            className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] disabled:opacity-40"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save
          </button>
        </div>
      </div>

      {saveError && (
        <div
          data-testid="wf-edit-save-error"
          className="flex items-start gap-2 border-b border-[var(--system-red)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] px-[var(--space-4)] py-2 text-[length:var(--text-caption1)] text-[var(--system-red)]"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <div className="font-[var(--weight-semibold)]">{saveError.message}</div>
            {saveError.errors?.map((e, i) => (
              <div key={i}>{e.path ? `${e.path}: ` : ""}{e.message}</div>
            ))}
            {saveError.message.toLowerCase().includes("version") && (
              <button type="button" onClick={load} className="mt-1 underline">
                Reload latest
              </button>
            )}
          </div>
        </div>
      )}

      <WakeUpEditor draft={wakeUpDraft} loadError={triggerLoadError} onChange={onWakeUpDraftChange} />

      {activeTriggerBinding?.kind === "poll" && activeTriggerBinding.approval && (
        <div
          data-testid="wf-poll-approval"
          className="mx-[var(--space-4)] mt-2 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-2 text-[length:var(--text-caption1)]"
        >
          <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {activeTriggerBinding.approval.state === "pending"
              ? "Pending approval"
              : activeTriggerBinding.approval.state === "approved"
                ? "Approved"
                : "Rejected"}
          </span>
          <span className="text-[var(--text-tertiary)]">
            {activeTriggerBinding.approval.state === "pending" && !activeTriggerBinding.approvalCapability?.canDecide
              ? `Poll activation · waiting for ${activeTriggerBinding.approval.target ?? "an organization approver"}`
              : `Poll activation · routed to ${activeTriggerBinding.approval.target ?? "an organization approver"}`}
          </span>
          {activeTriggerBinding.approval.state === "pending" && activeTriggerBinding.approvalCapability?.canDecide && (
            <div className="ml-auto flex gap-1.5">
              <button
                type="button"
                data-testid="wf-poll-reject"
                disabled={triggerApprovalBusy}
                onClick={() => void decidePollActivation("reject")}
                className="min-h-8 rounded-[var(--radius-sm)] px-2.5 text-[var(--system-red)] hover:bg-[var(--fill-quaternary)] disabled:opacity-40"
              >
                Reject
              </button>
              <button
                type="button"
                data-testid="wf-poll-approve"
                disabled={triggerApprovalBusy}
                onClick={() => void decidePollActivation("approve")}
                className="min-h-8 rounded-[var(--radius-sm)] bg-[var(--accent)] px-2.5 font-[var(--weight-semibold)] text-[var(--accent-contrast)] disabled:opacity-40"
              >
                Approve
              </button>
            </div>
          )}
          {triggerApprovalError && <span className="w-full text-[var(--system-red)]">{triggerApprovalError}</span>}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <WorkflowCanvas
              nodes={nodes}
              edges={canvasEdges}
              selectedId={selectedNodeId}
              onSelect={setSelectedNodeId}
              editable
              onPositionChange={moveGraphNode}
              onConnectNodes={connectGraphNodes}
              onRemoveNode={removeGraphNode}
              onRemoveEdge={removeGraphEdge}
              onTidy={tidying ? undefined : tidy}
              framingKey={`${def.id}:${def.version}:${layoutPreview ? "preview" : "draft"}`}
            />
          </div>
          <div className="shrink-0 border-t border-[var(--separator)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
            Edit mode · changes save to the workflow definition (v{def.version}), never to past runs · tap a node to edit
          </div>
        </div>

        {selectedNode && drafts[selectedNode.id] && (
          <>
            {/* Shared inspector shell (inspector-shell.tsx): borderless floating
                panel on desktop, opaque bottom sheet with scrim + grabber +
                safe-area on mobile — same shell the Live/Runs inspectors use. */}
            <InspectorPanel>
              <EditableNodeInspector
                node={selectedNode}
                draft={drafts[selectedNode.id]}
                onChange={(p) => onNodeDraftChange(selectedNode.id, p)}
                onClose={() => setSelectedNodeId(null)}
                onRemove={selectedNode.kind === "trigger" ? undefined : () => removeGraphNode(selectedNode.id)}
              />
            </InspectorPanel>
            <InspectorSheet onClose={() => setSelectedNodeId(null)}>
              <EditableNodeInspector
                node={selectedNode}
                draft={drafts[selectedNode.id]}
                onChange={(p) => onNodeDraftChange(selectedNode.id, p)}
                onClose={() => setSelectedNodeId(null)}
                onRemove={selectedNode.kind === "trigger" ? undefined : () => removeGraphNode(selectedNode.id)}
              />
            </InspectorSheet>
          </>
        )}
      </div>
    </div>
  )
}
