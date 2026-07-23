import { useEffect } from "react"
import { Handle, Position, useInternalNode, useNodeConnections, useUpdateNodeInternals, type NodeProps } from "@xyflow/react"
import { Plus } from "lucide-react"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { NodeTypeMenu, useMenu } from "./add-menu"
import { createWorkflowNode, type EditorNode } from "./graph"
import { freeCenter } from "./layout"
import { NodeTypeIcon } from "./node-icons"
import {
  COND_HEADER,
  COND_ROW,
  DISC_SIZE,
  NODE_WIDTH,
  conditionCases,
  inputConnectionLimit,
  nodeBox,
  outputPorts,
  type OutputPortSpec,
  type WorkflowNodeTypeV2,
  type WorkflowNodeWire,
} from "./ports"
import { useEditorApi } from "./store"
import { StatusGlyph } from "../run-support"
import type { NodeRunView } from "./graph"

const DOT = (
  <span
    aria-hidden
    className="pointer-events-none absolute inset-0 m-auto size-2 rounded-full"
    style={{ background: "var(--separator-opaque)", boxShadow: "0 0 0 2px var(--bg)" }}
  />
)

/** Invisible 24px hit area with the visible 8px socket dot centered on the wall. */
const handleStyle = { width: 24, height: 24, background: "transparent", border: "none", borderRadius: 12 }

function InputHandle({ node, readOnly }: { node: WorkflowNodeWire; readOnly?: boolean }) {
  const limit = inputConnectionLimit(node.type)
  const connections = useNodeConnections({ handleType: "target", handleId: "input" })
  return (
    <Handle
      type="target"
      position={Position.Left}
      id="input"
      isConnectable={!readOnly && (limit === undefined || connections.length < limit)}
      style={{ ...handleStyle, left: 0, top: "50%", transform: "translate(-50%, -50%)" }}
    >
      {DOT}
    </Handle>
  )
}

/** The template's add-from-free-handle `+`: editor-only (it writes into the
 *  editor store), mounted next to a source port when nothing is connected. */
function FreeHandleAdd({ nodeId, spec, bottom }: { nodeId: string; spec: OutputPortSpec; bottom: boolean }) {
  const connections = useNodeConnections({ handleType: "source", handleId: spec.id })
  const store = useEditorApi()
  const internal = useInternalNode(nodeId)
  const menu = useMenu()
  if (connections.length !== 0) return null

  const onPick = (type: WorkflowNodeTypeV2) => {
    const origin = internal?.internals.positionAbsolute ?? { x: 0, y: 0 }
    const state = store.getState()
    const desired = bottom
      ? { x: origin.x + spec.x, y: origin.y + spec.y + 150 }
      : { x: origin.x + spec.x + 140 + NODE_WIDTH / 2, y: origin.y + spec.y }
    const box = nodeBox(createWorkflowNode(type, "?"))
    const id = state.addNodeAt(type, freeCenter(state.nodes, desired, box))
    state.connect(nodeId, spec.id, id)
    menu.setOpen(false)
  }

  return (
    <span
      className={`absolute ${bottom ? "left-1/2 top-full mt-[18px] -translate-x-1/2" : "left-full top-1/2 ml-[10px] -translate-y-1/2"}`}
    >
      <button
        type="button"
        aria-label={`Add node after ${spec.label || spec.id}`}
        onClick={(event) => {
          event.stopPropagation()
          menu.setOpen(!menu.open)
        }}
        className="nodrag nopan grid size-5 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
        style={{ background: "var(--material-regular)", boxShadow: "var(--shadow-overlay)" }}
      >
        <Plus size={12} strokeWidth={2.25} aria-hidden />
      </button>
      {menu.open && (
        <div ref={menu.ref} className="nodrag nopan absolute left-1/2 z-50 mt-1.5 -translate-x-1/2">
          <NodeTypeMenu onPick={onPick} />
        </div>
      )}
    </span>
  )
}

/** A source port: socket dot on the wall, label decoration for failure lanes,
 *  and (in the editor) the add-from-free-handle `+`. */
function OutputHandle({ nodeId, spec, readOnly }: { nodeId: string; spec: OutputPortSpec; readOnly?: boolean }) {
  const bottom = spec.wall === "bottom"
  const position = bottom ? Position.Bottom : Position.Right
  const style = { ...handleStyle, left: spec.x, top: spec.y, transform: "translate(-50%, -50%)" }

  return (
    <Handle type="source" position={position} id={spec.id} style={style} isConnectable={!readOnly}>
      {DOT}
      {bottom && spec.label && (
        <span
          className="pointer-events-none absolute left-1/2 top-full -translate-x-1/2 text-[10px] font-[var(--weight-medium)] text-[var(--text-tertiary)]"
          style={{ marginTop: 2 }}
        >
          {spec.label}
        </span>
      )}
      {!readOnly && <FreeHandleAdd nodeId={nodeId} spec={spec} bottom={bottom} />}
    </Handle>
  )
}

/** Status ring tints for live/attention states; settled states rely on the
 *  badge alone so a finished run reads calm, not decorated. */
const RUN_RING: Record<string, string> = {
  dispatching: "var(--system-blue)",
  running: "var(--system-blue)",
  waiting: "var(--system-orange)",
  "waiting-submit": "var(--system-orange)",
  failed: "var(--system-red)",
}

const BADGELESS_RUN_STATUSES = new Set(["pending", "ready", "skipped"])

function RunStatusBadge({ status }: { status: string }) {
  if (BADGELESS_RUN_STATUSES.has(status)) return null
  return (
    <span
      data-testid="run-status-badge"
      aria-hidden
      className="absolute -right-1.5 -top-1.5 grid size-[18px] place-items-center rounded-full"
      style={{ background: "var(--bg-secondary)", boxShadow: "var(--shadow-overlay)" }}
    >
      <StatusGlyph status={status} />
    </span>
  )
}

function CardShell({
  node,
  selected,
  run,
  children,
  radius = "var(--radius-lg)",
}: {
  node: WorkflowNodeWire
  selected: boolean
  run?: NodeRunView
  children: React.ReactNode
  radius?: string
}) {
  const box = nodeBox(node)
  const ring = selected
    ? "color-mix(in srgb, var(--accent) 50%, transparent)"
    : run && RUN_RING[run.status]
      ? `color-mix(in srgb, ${RUN_RING[run.status]} 45%, transparent)`
      : null
  return (
    <div
      className="relative"
      data-node-status={run?.status}
      style={{
        width: box.width,
        height: box.height,
        background: "var(--bg-secondary)",
        borderRadius: radius,
        boxShadow: ring ? `var(--shadow-card), 0 0 0 2px ${ring}` : "var(--shadow-card)",
        opacity: run?.dimmed && !selected ? 0.55 : undefined,
        transition: "box-shadow 0.2s ease, opacity 0.2s ease",
      }}
    >
      {children}
      {run && <RunStatusBadge status={run.status} />}
    </div>
  )
}

function triggerCaption(node: WorkflowNodeWire): string {
  const config = node.config as { kind?: unknown; cron?: unknown }
  switch (config.kind) {
    case "schedule":
      return typeof config.cron === "string" && config.cron ? config.cron : "Schedule"
    case "event": return "On event"
    case "todo-status": return "On Todo status"
    case "workflow-call": return "Called by workflow"
    default: return "Manual"
  }
}

function nodeCaption(node: WorkflowNodeWire): string {
  const config = node.config as Record<string, unknown>
  switch (node.type) {
    case "trigger": return triggerCaption(node)
    case "employee": {
      const employee = config.employee as { source?: unknown; value?: unknown } | undefined
      return employee?.source === "fixed" && typeof employee.value === "string" && employee.value
        ? employee.value
        : "Choose employee"
    }
    case "approval": {
      const description = config.description
      return typeof description === "string" && description.trim() ? description : "Approval gate"
    }
    case "wait":
      return config.mode === "until" ? "Until timestamp" : `${typeof config.minutes === "number" ? config.minutes : "?"} min`
    case "end":
      return config.result === "failure" ? "Failure" : "Success"
    default:
      return ""
  }
}

function employeeName(node: WorkflowNodeWire): string | null {
  if (node.type !== "employee") return null
  const employee = (node.config as { employee?: { source?: unknown; value?: unknown } }).employee
  return employee?.source === "fixed" && typeof employee.value === "string" && employee.value ? employee.value : null
}

function StandardCard({ data, selected }: NodeProps<EditorNode>) {
  const node = data.node
  const readOnly = data.run !== undefined
  const employee = employeeName(node)
  return (
    <CardShell node={node} selected={selected ?? false} run={data.run}>
      <div className="flex h-full items-center gap-2.5 px-3.5">
        {employee ? (
          <EmployeeAvatar name={employee} size={32} className="bg-[var(--fill-secondary)]" />
        ) : (
          <NodeTypeIcon type={node.type} node={node} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {node.name}
          </span>
          <span className="block truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
            {nodeCaption(node)}
          </span>
        </span>
      </div>
      {node.type !== "trigger" && <InputHandle node={node} readOnly={readOnly} />}
      {outputPorts(node).map((spec) => (
        <OutputHandle key={spec.id} nodeId={node.id} spec={spec} readOnly={readOnly} />
      ))}
    </CardShell>
  )
}

function ConditionCard({ data, selected }: NodeProps<EditorNode>) {
  const node = data.node
  const readOnly = data.run !== undefined
  const updateInternals = useUpdateNodeInternals()
  const ports = outputPorts(node)
  const portKey = ports.map((port) => port.id).join("\0")
  useEffect(() => {
    updateInternals(node.id)
  }, [node.id, portKey, updateInternals])

  const cases = conditionCases(node)
  return (
    <CardShell node={node} selected={selected ?? false} run={data.run}>
      <div className="flex items-center gap-2.5 px-3.5" style={{ height: COND_HEADER }}>
        <NodeTypeIcon type="condition" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {node.name}
          </span>
          <span className="block text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
            {cases.length === 1 ? "1 route" : `${cases.length} routes`} + else
          </span>
        </span>
      </div>
      {[...cases.map((item) => item.label), "else"].map((label, index) => (
        <div
          key={index}
          className="flex items-center justify-end pl-3.5 pr-4"
          style={{ height: COND_ROW }}
        >
          {index < cases.length ? (
            <span className="max-w-full truncate rounded-full bg-[var(--fill-tertiary)] px-2 py-0.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--text-secondary)]">
              {label}
            </span>
          ) : (
            <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">else</span>
          )}
        </div>
      ))}
      <InputHandle node={node} readOnly={readOnly} />
      {ports.map((spec) => (
        <OutputHandle key={spec.id} nodeId={node.id} spec={spec} readOnly={readOnly} />
      ))}
    </CardShell>
  )
}

function MergeDisc({ data, selected }: NodeProps<EditorNode>) {
  const node = data.node
  const readOnly = data.run !== undefined
  return (
    <CardShell node={node} selected={selected ?? false} run={data.run} radius="16px">
      <div className="grid h-full w-full place-items-center">
        <NodeTypeIcon type="merge" size={DISC_SIZE - 24} iconSize={15} />
      </div>
      <span
        className="pointer-events-none absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
      >
        {node.name}
      </span>
      <InputHandle node={node} readOnly={readOnly} />
      {outputPorts(node).map((spec) => (
        <OutputHandle key={spec.id} nodeId={node.id} spec={spec} readOnly={readOnly} />
      ))}
    </CardShell>
  )
}

export const editorNodeTypes = {
  trigger: StandardCard,
  employee: StandardCard,
  approval: StandardCard,
  wait: StandardCard,
  end: StandardCard,
  condition: ConditionCard,
  merge: MergeDisc,
}
