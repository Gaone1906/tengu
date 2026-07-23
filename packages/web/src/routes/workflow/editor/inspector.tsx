import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useShallow } from "zustand/react/shallow"
import { Plus, Trash2, X } from "lucide-react"
import { api } from "@/lib/api"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { allocateConditionPort } from "./graph"
import { NodeTypeIcon } from "./node-icons"
import { NODE_TYPE_LABEL, conditionCases, type WorkflowNodeWire } from "./ports"
import { useEditor } from "./store"

/* ── tiny form primitives (Ledger-styled, matching ui/textarea) ───────────── */

function TextInput(props: React.ComponentProps<"input">) {
  const { className = "", ...rest } = props
  return (
    <input
      {...rest}
      className={`h-8 w-full rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-quaternary)] px-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:border-[var(--accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] ${className}`}
    />
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
        {label}
      </span>
      {children}
    </label>
  )
}

function PickerField({
  label, value, onChange, options, placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  placeholder?: string
}) {
  return (
    <Field label={label}>
      {/* "" is a controlled empty selection — `|| undefined` would flip the
          Select uncontrolled→controlled on first pick and warn. */}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder={placeholder ?? "Choose…"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/* ── binding helpers: plain text ⇄ fixed bindings ─────────────────────────── */

type BindingWire = { source?: unknown; value?: unknown; path?: unknown; nodeId?: unknown }

function fixedText(value: unknown): string {
  const binding = value as BindingWire | undefined
  return binding?.source === "fixed" && typeof binding.value === "string" ? binding.value : ""
}

function withFixed(config: Record<string, unknown>, key: string, text: string, keepEmpty = false): Record<string, unknown> {
  const next = { ...config }
  if (!text && !keepEmpty) delete next[key]
  else next[key] = { source: "fixed", value: text }
  return next
}

/** Fixed predicate values coerce sensibly: true/false → boolean, numerics → number. */
function parseFixedValue(text: string): unknown {
  if (text === "true") return true
  if (text === "false") return false
  if (text.trim() !== "" && Number.isFinite(Number(text))) return Number(text)
  return text
}

function fixedValueText(value: unknown): string {
  const binding = value as BindingWire | undefined
  if (binding?.source !== "fixed") return ""
  return typeof binding.value === "string" ? binding.value : JSON.stringify(binding.value ?? "")
}

/* ── per-type forms ───────────────────────────────────────────────────────── */

interface FormProps {
  node: WorkflowNodeWire
  update: (config: Record<string, unknown>) => void
}

const TRIGGER_KINDS = [
  { value: "manual", label: "Manual" },
  { value: "schedule", label: "Schedule" },
  { value: "event", label: "Event" },
  { value: "todo-status", label: "Todo status" },
  { value: "workflow-call", label: "Workflow call" },
]

const TODO_STATUSES = ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"]

function defaultTriggerConfig(kind: string): Record<string, unknown> {
  switch (kind) {
    case "schedule":
      return { kind, cron: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }
    case "event": return { kind, eventName: "event" }
    case "todo-status": return { kind, status: "in_review" }
    default: return { kind }
  }
}

function TriggerForm({ node, update }: FormProps) {
  const config = node.config as { kind?: string; cron?: string; timezone?: string; eventName?: string; status?: string }
  const kind = config.kind ?? "manual"
  return (
    <>
      <PickerField
        label="Fires on"
        value={kind}
        onChange={(next) => update(defaultTriggerConfig(next))}
        options={TRIGGER_KINDS}
      />
      {kind === "schedule" && (
        <>
          <Field label="Cron">
            <TextInput
              value={config.cron ?? ""}
              onChange={(event) => update({ ...node.config, cron: event.target.value })}
              placeholder="0 9 * * *"
              style={{ fontFamily: "var(--font-code)" }}
            />
          </Field>
          <Field label="Timezone">
            <TextInput
              value={config.timezone ?? ""}
              onChange={(event) => update({ ...node.config, timezone: event.target.value })}
              placeholder="Europe/Sofia"
            />
          </Field>
        </>
      )}
      {kind === "event" && (
        <Field label="Event name">
          <TextInput
            value={config.eventName ?? ""}
            onChange={(event) => update({ ...node.config, eventName: event.target.value })}
            placeholder="deploy-finished"
          />
        </Field>
      )}
      {kind === "todo-status" && (
        <PickerField
          label="Todo moves to"
          value={config.status ?? "in_review"}
          onChange={(next) => update({ ...node.config, status: next })}
          options={TODO_STATUSES.map((status) => ({ value: status, label: status }))}
        />
      )}
    </>
  )
}

const EFFORTS = ["low", "medium", "high", "xhigh"]
const CLEAR = "__none__"
const OUTPUT_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/
const OUTPUT_FIELD_TYPES = ["string", "number", "boolean", "string[]"] as const

type OutputFieldType = typeof OUTPUT_FIELD_TYPES[number]
type OutputFieldConfig = {
  type: OutputFieldType
  required: boolean
  description?: string
}
type OutputSchemaConfig = {
  fields: Record<string, OutputFieldConfig>
  allowAdditionalFields: boolean
}

function OutputFieldRow({
  index,
  name,
  field,
  existingNames,
  onRename,
  onChange,
  onRemove,
}: {
  index: number
  name: string
  field: OutputFieldConfig
  existingNames: string[]
  onRename: (name: string) => void
  onChange: (field: OutputFieldConfig) => void
  onRemove: () => void
}) {
  const [draftName, setDraftName] = useState(name)
  const [nameError, setNameError] = useState<string | null>(null)

  useEffect(() => setDraftName(name), [name])

  const changeName = (next: string) => {
    setDraftName(next)
    if (!OUTPUT_FIELD_NAME.test(next)) {
      setNameError("Use letters, numbers, underscores, or hyphens; start with a letter or underscore.")
      return
    }
    if (next !== name && existingNames.includes(next)) {
      setNameError("Use a unique field name.")
      return
    }
    setNameError(null)
    if (next !== name) onRename(next)
  }

  return (
    <div className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-2.5">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <TextInput
            aria-label={`Output field ${index + 1} name`}
            value={draftName}
            onChange={(event) => changeName(event.target.value)}
            placeholder="result"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `output-field-${index}-error` : undefined}
            style={{ fontFamily: "var(--font-code)" }}
          />
          {nameError && (
            <p id={`output-field-${index}-error`} className="mt-1 text-[length:var(--text-caption2)] text-[var(--system-red)]">
              {nameError}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label={`Remove output field ${name}`}
          onClick={onRemove}
          className="grid size-8 shrink-0 place-items-center rounded-[9px] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
        <PickerField
          label="Type"
          value={field.type}
          onChange={(type) => onChange({ ...field, type: type as OutputFieldType })}
          options={OUTPUT_FIELD_TYPES.map((type) => ({ value: type, label: type }))}
        />
        <label className="flex h-8 items-center gap-1.5 px-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            aria-label={`Output field ${index + 1} required`}
            checked={field.required}
            onChange={(event) => onChange({ ...field, required: event.target.checked })}
            className="size-4 accent-[var(--accent)]"
          />
          Required
        </label>
      </div>
      <Field label="Description">
        <TextInput
          aria-label={`Output field ${index + 1} description`}
          value={field.description ?? ""}
          onChange={(event) => {
            const description = event.target.value
            const next = { ...field }
            if (description) next.description = description
            else delete next.description
            onChange(next)
          }}
          placeholder="What this field contains"
        />
      </Field>
    </div>
  )
}

function OutputSchemaForm({
  config,
  update,
}: {
  config: Record<string, unknown>
  update: (config: Record<string, unknown>) => void
}) {
  const output = config.output as OutputSchemaConfig | undefined

  const disable = () => {
    const next = { ...config }
    delete next.output
    update(next)
  }

  if (!output) {
    return (
      <section className="rounded-[var(--radius-lg)] border border-[var(--separator)] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Output</h3>
            <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">No structured output</p>
          </div>
          <button
            type="button"
            onClick={() => update({
              ...config,
              output: {
                fields: { result: { type: "string", required: false } },
                allowAdditionalFields: false,
              },
            })}
            className="h-8 rounded-[9px] bg-[var(--fill-tertiary)] px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
          >
            Enable structured output
          </button>
        </div>
      </section>
    )
  }

  const entries = Object.entries(output.fields)
  const setOutput = (next: OutputSchemaConfig) => update({ ...config, output: next })
  const setField = (name: string, field: OutputFieldConfig) =>
    setOutput({ ...output, fields: { ...output.fields, [name]: field } })
  const renameField = (name: string, nextName: string) => {
    const fields = Object.fromEntries(entries.map(([key, field]) => [key === name ? nextName : key, field]))
    setOutput({ ...output, fields })
  }
  const removeField = (name: string) => {
    const fields = Object.fromEntries(entries.filter(([key]) => key !== name))
    if (Object.keys(fields).length === 0) disable()
    else setOutput({ ...output, fields })
  }
  const addField = () => {
    let name = "field"
    let suffix = 2
    while (Object.hasOwn(output.fields, name)) {
      name = `field_${suffix}`
      suffix += 1
    }
    setOutput({ ...output, fields: { ...output.fields, [name]: { type: "string", required: false } } })
  }

  return (
    <section className="space-y-2.5 rounded-[var(--radius-lg)] border border-[var(--separator)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Output</h3>
        <button
          type="button"
          onClick={disable}
          className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] hover:text-[var(--system-red)]"
        >
          Disable structured output
        </button>
      </div>
      {entries.map(([name, field], index) => (
        <OutputFieldRow
          key={name}
          index={index}
          name={name}
          field={field}
          existingNames={entries.map(([key]) => key)}
          onRename={(nextName) => renameField(name, nextName)}
          onChange={(nextField) => setField(name, nextField)}
          onRemove={() => removeField(name)}
        />
      ))}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={addField}
          className="flex h-8 items-center gap-1.5 rounded-[9px] px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
        >
          <Plus size={13} aria-hidden /> Add field
        </button>
        <label className="flex items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={output.allowAdditionalFields}
            onChange={(event) => setOutput({ ...output, allowAdditionalFields: event.target.checked })}
            className="size-4 accent-[var(--accent)]"
          />
          Allow additional fields
        </label>
      </div>
    </section>
  )
}

function EmployeeForm({ node, update }: FormProps) {
  const org = useQuery({ queryKey: ["org"], queryFn: api.getOrg, staleTime: 60_000 })
  const config = node.config as Record<string, unknown>
  const employees = org.data?.employees ?? []
  const effort = fixedText(config.effort)
  return (
    <>
      <PickerField
        label="Employee"
        value={fixedText(config.employee)}
        onChange={(next) => update(withFixed(config, "employee", next, true))}
        options={employees.map((employee) => ({ value: employee.name, label: employee.name }))}
        placeholder={org.isPending ? "Loading…" : "Choose employee"}
      />
      <Field label="Prompt">
        <Textarea
          rows={6}
          value={typeof config.prompt === "string" ? config.prompt : ""}
          onChange={(event) => update({ ...config, prompt: event.target.value })}
          placeholder="What should this employee do?"
        />
      </Field>
      <PickerField
        label="Effort"
        value={effort || CLEAR}
        onChange={(next) => update(withFixed(config, "effort", next === CLEAR ? "" : next))}
        options={[{ value: CLEAR, label: "Default" }, ...EFFORTS.map((value) => ({ value, label: value }))]}
      />
      <OutputSchemaForm config={config} update={update} />
      <section className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--separator)] p-3">
        <h3 className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Advanced</h3>
        <Field label="Timeout (minutes)">
          <TextInput
            type="number"
            min={1}
            max={1440}
            step={1}
            value={typeof config.timeoutMinutes === "number" ? String(config.timeoutMinutes) : ""}
            onChange={(event) => {
              const next = { ...config }
              if (event.target.value === "") {
                delete next.timeoutMinutes
              } else {
                next.timeoutMinutes = Math.max(1, Math.min(1440, Math.round(Number(event.target.value))))
              }
              update(next)
            }}
            placeholder="No hard timeout"
          />
        </Field>
      </section>
    </>
  )
}

const OPERATORS = ["equals", "not-equals", "exists", "not-exists", "contains", "gt", "gte", "lt", "lte", "in"]
const SOURCES = [
  { value: "node", label: "Node output" },
  { value: "trigger", label: "Trigger" },
  { value: "input", label: "Run input" },
  { value: "run", label: "Run" },
  { value: "fixed", label: "Fixed value" },
]

type PredicateWire = { left?: BindingWire; operator?: string; right?: BindingWire }
type CaseWire = { port: string; label?: string; all?: PredicateWire[] }

function BindingEditor({
  value, onChange, nodeIds,
}: {
  value: BindingWire
  onChange: (next: BindingWire) => void
  nodeIds: string[]
}) {
  const source = typeof value.source === "string" ? value.source : "node"
  return (
    <div className="flex min-w-0 flex-1 flex-wrap gap-1">
      <Select value={source} onValueChange={(next) => {
        if (next === "fixed") onChange({ source: "fixed", value: "" })
        else if (next === "node") onChange({ source: "node", nodeId: nodeIds[0] ?? "", path: "text" })
        else onChange({ source: next, path: typeof value.path === "string" && value.path ? value.path : "payload" })
      }}>
        <SelectTrigger aria-label="Value source" className="h-8 w-auto min-w-[104px] flex-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SOURCES.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {source === "node" && (
        <Select
          value={typeof value.nodeId === "string" ? value.nodeId : ""}
          onValueChange={(next) => onChange({ ...value, nodeId: next })}
        >
          <SelectTrigger aria-label="Source node" className="h-8 w-auto min-w-[96px] flex-none">
            <SelectValue placeholder="node" />
          </SelectTrigger>
          <SelectContent>
            {nodeIds.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {source === "fixed" ? (
        <TextInput
          aria-label="Fixed value"
          value={fixedValueText(value)}
          onChange={(event) => onChange({ source: "fixed", value: parseFixedValue(event.target.value) })}
          placeholder="value"
          className="min-w-[80px] flex-1"
        />
      ) : (
        <TextInput
          aria-label="Path"
          value={typeof value.path === "string" ? value.path : ""}
          onChange={(event) => onChange({ ...value, path: event.target.value })}
          placeholder="fields.result"
          className="min-w-[80px] flex-1"
          style={{ fontFamily: "var(--font-code)" }}
        />
      )}
    </div>
  )
}

function ConditionForm({ node, update }: FormProps) {
  // useShallow keeps the snapshot stable — a fresh array per getSnapshot call
  // loops useSyncExternalStore into React #185 and crashes the editor.
  const nodeIds = useEditor(useShallow((state) => state.nodes.map((item) => item.id))).filter((id) => id !== node.id)
  const config = node.config as { cases?: CaseWire[]; defaultPort?: string }
  const cases = Array.isArray(config.cases) ? config.cases : []

  const setCases = (next: CaseWire[]) => update({ ...node.config, cases: next })
  const patchCase = (index: number, patch: Partial<CaseWire>) =>
    setCases(cases.map((item, i) => (i === index ? { ...item, ...patch } : item)))

  return (
    <>
      {cases.map((item, index) => {
        const predicates = Array.isArray(item.all) ? item.all : []
        return (
          <div key={item.port} className="rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <TextInput
                aria-label={`Route ${index + 1} label`}
                value={item.label ?? ""}
                onChange={(event) => patchCase(index, { label: event.target.value })}
                placeholder={`Route ${index + 1}`}
                className="flex-1 bg-[var(--bg-secondary)]"
              />
              <button
                type="button"
                aria-label={`Remove route ${item.label || item.port}`}
                onClick={() => setCases(cases.filter((_, i) => i !== index))}
                className="grid size-8 shrink-0 place-items-center rounded-[9px] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
            {predicates.map((predicate, predicateIndex) => (
              <div key={predicateIndex} className="mb-1.5 space-y-1">
                <div className="flex items-center gap-1">
                  <BindingEditor
                    value={predicate.left ?? { source: "node", nodeId: nodeIds[0] ?? "", path: "text" }}
                    onChange={(left) => patchCase(index, {
                      all: predicates.map((p, i) => (i === predicateIndex ? { ...p, left } : p)),
                    })}
                    nodeIds={nodeIds}
                  />
                  <button
                    type="button"
                    aria-label="Remove check"
                    onClick={() => patchCase(index, { all: predicates.filter((_, i) => i !== predicateIndex) })}
                    className="grid size-7 shrink-0 place-items-center rounded-[8px] text-[var(--text-quaternary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
                  >
                    <X size={13} aria-hidden />
                  </button>
                </div>
                <div className="flex gap-1">
                  <Select
                    value={predicate.operator ?? "equals"}
                    onValueChange={(operator) => patchCase(index, {
                      all: predicates.map((p, i) => (i === predicateIndex ? { ...p, operator } : p)),
                    })}
                  >
                    <SelectTrigger aria-label="Operator" className="h-8 w-auto min-w-[104px] flex-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPERATORS.map((operator) => (
                        <SelectItem key={operator} value={operator}>{operator}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {predicate.operator !== "exists" && predicate.operator !== "not-exists" && (
                    <TextInput
                      aria-label="Compare to"
                      value={fixedValueText(predicate.right)}
                      onChange={(event) => patchCase(index, {
                        all: predicates.map((p, i) => (i === predicateIndex
                          ? { ...p, right: { source: "fixed", value: parseFixedValue(event.target.value) } }
                          : p)),
                      })}
                      placeholder="value"
                      className="flex-1"
                    />
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => patchCase(index, {
                all: [...predicates, { left: { source: "node", nodeId: nodeIds[0] ?? "", path: "text" }, operator: "equals", right: { source: "fixed", value: "" } }],
              })}
              className="flex h-7 items-center gap-1 rounded-[8px] px-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
            >
              <Plus size={12} aria-hidden /> Add check
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => {
          const taken = new Set([...cases.map((item) => item.port), config.defaultPort ?? "else"])
          const port = allocateConditionPort(taken)
          setCases([...cases, { port, label: `Route ${cases.length + 1}`, all: [] }])
        }}
        className="flex h-8 items-center gap-1.5 rounded-[9px] px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
      >
        <Plus size={13} aria-hidden /> Add route
      </button>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Anything that matches no route takes the <span className="font-[var(--weight-semibold)]">else</span> path.
        A route with no checks always matches.
      </p>
    </>
  )
}

function ApprovalForm({ node, update }: FormProps) {
  const config = node.config as Record<string, unknown>
  return (
    <>
      <Field label="What needs approval?">
        <Textarea
          rows={3}
          value={typeof config.description === "string" ? config.description : ""}
          onChange={(event) => update({ ...config, description: event.target.value })}
          placeholder="Describe the decision"
        />
      </Field>
      <Field label="Approver (optional)">
        <TextInput
          value={fixedText(config.approver)}
          onChange={(event) => update(withFixed(config, "approver", event.target.value))}
          placeholder="operator"
        />
      </Field>
    </>
  )
}

function WaitForm({ node, update }: FormProps) {
  const config = node.config as { mode?: string; minutes?: number; timestamp?: unknown }
  const mode = config.mode === "until" ? "until" : "duration"
  return (
    <>
      <PickerField
        label="Wait"
        value={mode}
        onChange={(next) => update(next === "until"
          ? { mode: "until", timestamp: { source: "fixed", value: "" } }
          : { mode: "duration", minutes: 60 })}
        options={[{ value: "duration", label: "For a duration" }, { value: "until", label: "Until a timestamp" }]}
      />
      {mode === "duration" ? (
        <Field label="Minutes">
          <TextInput
            type="number"
            min={1}
            max={43_200}
            value={typeof config.minutes === "number" ? String(config.minutes) : ""}
            onChange={(event) => {
              const minutes = Math.max(1, Math.min(43_200, Math.round(Number(event.target.value)) || 1))
              update({ mode: "duration", minutes })
            }}
          />
        </Field>
      ) : (
        <Field label="Timestamp (ISO)">
          <TextInput
            value={fixedText(config.timestamp)}
            onChange={(event) => update({ mode: "until", timestamp: { source: "fixed", value: event.target.value } })}
            placeholder="2026-08-01T09:00:00Z"
            style={{ fontFamily: "var(--font-code)" }}
          />
        </Field>
      )}
    </>
  )
}

function EndForm({ node, update }: FormProps) {
  const config = node.config as Record<string, unknown>
  return (
    <>
      <PickerField
        label="Result"
        value={config.result === "failure" ? "failure" : "success"}
        onChange={(next) => update({ ...config, result: next })}
        options={[{ value: "success", label: "Success" }, { value: "failure", label: "Failure" }]}
      />
      <Field label="Message (optional)">
        <TextInput
          value={typeof config.message === "string" ? config.message : ""}
          onChange={(event) => {
            const next = { ...config }
            if (event.target.value) next.message = event.target.value
            else delete next.message
            update(next)
          }}
          placeholder="Shown on the run"
        />
      </Field>
    </>
  )
}

/* ── the panel ────────────────────────────────────────────────────────────── */

function NodeForm({ node, update }: FormProps) {
  switch (node.type) {
    case "trigger": return <TriggerForm node={node} update={update} />
    case "employee": return <EmployeeForm node={node} update={update} />
    case "condition": return <ConditionForm node={node} update={update} />
    case "approval": return <ApprovalForm node={node} update={update} />
    case "wait": return <WaitForm node={node} update={update} />
    case "end": return <EndForm node={node} update={update} />
    case "merge":
      return (
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          Waits for every incoming branch to finish, then continues.
        </p>
      )
  }
}

function InspectorBody({ node }: { node: WorkflowNodeWire }) {
  const renameNode = useEditor((state) => state.renameNode)
  const updateNodeConfig = useEditor((state) => state.updateNodeConfig)
  const removeNode = useEditor((state) => state.removeNode)
  const selectNode = useEditor((state) => state.selectNode)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-3.5">
        <NodeTypeIcon type={node.type} node={node} size={26} iconSize={13} />
        <span className="flex-1 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {NODE_TYPE_LABEL[node.type]}
        </span>
        <button
          type="button"
          aria-label="Delete node"
          onClick={() => removeNode(node.id)}
          className="grid size-8 place-items-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
        >
          <Trash2 size={15} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Close properties"
          onClick={() => selectNode(null)}
          className="grid size-8 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4" data-scrollable="true">
        <Field label="Name">
          <TextInput
            value={node.name}
            onChange={(event) => renameNode(node.id, event.target.value)}
            onBlur={(event) => {
              if (!event.target.value.trim()) renameNode(node.id, NODE_TYPE_LABEL[node.type])
            }}
          />
        </Field>
        <NodeForm node={node} update={(config) => updateNodeConfig(node.id, config)} />
        <p className="pt-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
          {node.id}
        </p>
      </div>
    </div>
  )
}

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)")?.matches === true,
  )
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 767px)")
    if (!query) return
    const onChange = () => setNarrow(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return narrow
}

/** Properties live in a right rail on desktop and a bottom sheet on mobile —
 *  ONE mounted body writing straight into the store node; there is no draft copy. */
export function Inspector() {
  const selected = useEditor((state) => state.nodes.find((node) => node.selected))
  const selectNode = useEditor((state) => state.selectNode)
  const narrow = useIsNarrow()
  if (!selected) return null
  const node = selected.data.node
  if (!narrow) {
    return (
      <aside className="absolute bottom-3 right-3 top-3 z-40 w-[324px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)]">
        <InspectorBody node={node} />
      </aside>
    )
  }
  return (
    <div className="fixed inset-x-0 z-40" style={{ bottom: "calc(49px + var(--safe-bottom))" }}>
      <button
        type="button"
        aria-label="Dismiss properties"
        onClick={() => selectNode(null)}
        className="absolute inset-x-0 -top-24 h-24"
      />
      <div
        className="max-h-[62vh] overflow-hidden rounded-t-[var(--radius-2xl)] bg-[var(--bg-secondary)] pb-2.5 shadow-[var(--shadow-overlay)]"
      >
        <div className="mx-auto mt-2 h-[5px] w-9 rounded-full bg-[var(--fill-secondary)]" aria-hidden />
        <div className="h-[min(56vh,480px)]">
          <InspectorBody node={node} />
        </div>
      </div>
    </div>
  )
}
