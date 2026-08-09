import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  api: {
    listLabels: () => Promise.resolve({
      labels: [
        { id: "lbl_build", name: "build", color: null, department: null, createdAt: "2026-07-23T08:00:00.000Z" },
      ],
    }),
    getOrg: () => Promise.resolve({
      departments: ["platform"],
      employees: [
        {
          name: "platform-lead",
          displayName: "Platform Lead",
          department: "platform",
          rank: "manager",
          engine: "codex",
          model: "model",
          persona: "Platform lead",
        },
      ],
      hierarchy: { root: null, sorted: [], warnings: [] },
    }),
  },
}))

import type { WorkflowDefinitionV2Wire } from "@/lib/api"
import { Inspector } from "../editor/inspector"
import { createEditorStore, EditorStoreContext } from "../editor/store"

const definition: WorkflowDefinitionV2Wire = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  revision: 3,
  enabled: false,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  nodes: [{
    id: "writer",
    type: "employee",
    name: "Writer",
    config: {
      employee: { source: "fixed", value: "writer" },
      prompt: "",
    },
  }],
  edges: [],
  ui: { positions: { writer: { x: 0, y: 0 } } },
}

function renderInspector(configPatch: Record<string, unknown> = {}) {
  const initial = structuredClone(definition)
  initial.nodes[0]!.config = { ...initial.nodes[0]!.config, ...configPatch }
  const store = createEditorStore(initial)
  store.getState().selectNode("writer")
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <EditorStoreContext.Provider value={store}>
        <Inspector />
      </EditorStoreContext.Provider>
    </QueryClientProvider>,
  )
  return store
}

function employeeConfig(store: ReturnType<typeof createEditorStore>) {
  return store.getState().nodes[0]!.data.node.config as Record<string, unknown>
}

function renderTrigger(config: Record<string, unknown>) {
  const initial = structuredClone(definition)
  initial.nodes = [{
    id: "trigger",
    type: "trigger",
    name: "Todo updated",
    config,
  }]
  initial.ui.positions = { trigger: { x: 0, y: 0 } }
  const store = createEditorStore(initial)
  store.getState().selectNode("trigger")
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <EditorStoreContext.Provider value={store}>
        <Inspector />
      </EditorStoreContext.Provider>
    </QueryClientProvider>,
  )
  return store
}

function triggerConfig(store: ReturnType<typeof createEditorStore>) {
  return store.getState().nodes[0]!.data.node.config as Record<string, unknown>
}

async function choose(label: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }))
  await userEvent.click(await screen.findByRole("option", { name: option }))
}

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("todo trigger filters", () => {
  it("shows the status and all four filters", () => {
    renderTrigger({ kind: "todo-status", status: "in_review" })

    expect(screen.getByRole("combobox", { name: "Todo moves to" })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Label" })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Department" })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Assignee" })).toBeTruthy()
    expect(screen.getByLabelText("Actor")).toBeTruthy()
  })

  it("keeps the Actor input at least 34px tall", () => {
    renderTrigger({ kind: "todo-status", status: "in_review" })

    expect(screen.getByLabelText("Actor").classList.contains("min-h-[34px]")).toBe(true)
  })

  it("renders stored values, including values missing from the registries", async () => {
    renderTrigger({
      kind: "todo-status",
      status: "in_review",
      label: "removed-label",
      department: "platform",
      assignee: "former-employee",
      actor: "operator",
    })

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Label" }).textContent).toContain("removed-label")
      expect(screen.getByRole("combobox", { name: "Department" }).textContent).toContain("platform")
      expect(screen.getByRole("combobox", { name: "Assignee" }).textContent).toContain("former-employee")
    })
    expect((screen.getByLabelText("Actor") as HTMLInputElement).value).toBe("operator")
  })

  it("writes a selected filter as a plain string", async () => {
    const store = renderTrigger({ kind: "todo-status", status: "in_review" })

    await choose("Department", "platform")

    expect(triggerConfig(store).department).toBe("platform")
  })

  it("removes a filter key when cleared", async () => {
    const store = renderTrigger({ kind: "todo-status", status: "in_review", label: "build" })

    await choose("Label", "Any label")

    expect(triggerConfig(store)).not.toHaveProperty("label")
  })

  it("drops stale filters when switching kind away and back", async () => {
    const store = renderTrigger({
      kind: "todo-status",
      status: "done",
      label: "build",
      department: "platform",
      assignee: "platform-lead",
      actor: "operator",
    })

    await choose("Fires on", "Manual")
    await choose("Fires on", "Todo status")

    expect(triggerConfig(store)).toEqual({ kind: "todo-status", status: "in_review" })
  })

  it.each(["manual", "schedule", "event", "workflow-call"])(
    "renders no filters for %s triggers",
    (kind) => {
      renderTrigger({ kind })

      expect(screen.queryByRole("combobox", { name: "Label" })).toBeNull()
      expect(screen.queryByRole("combobox", { name: "Department" })).toBeNull()
      expect(screen.queryByRole("combobox", { name: "Assignee" })).toBeNull()
      expect(screen.queryByLabelText("Actor")).toBeNull()
    },
  )
})

describe("employee inspector output schema", () => {
  it("enables structured output with a valid schema", async () => {
    const store = renderInspector()

    await userEvent.click(screen.getByRole("button", { name: "Enable structured output" }))

    expect(employeeConfig(store).output).toEqual({
      fields: {
        result: { type: "string", required: false },
      },
      allowAdditionalFields: false,
    })
  })

  it("shows an inline error for an invalid field name without committing it", async () => {
    const store = renderInspector()
    await userEvent.click(screen.getByRole("button", { name: "Enable structured output" }))

    fireEvent.change(screen.getByLabelText("Output field 1 name"), { target: { value: "bad.name" } })

    expect(screen.getByText("Use letters, numbers, underscores, or hyphens; start with a letter or underscore.")).toBeTruthy()
    expect(employeeConfig(store).output).toEqual({
      fields: {
        result: { type: "string", required: false },
      },
      allowAdditionalFields: false,
    })
  })

  it("disables structured output by removing the output config", async () => {
    const store = renderInspector()
    await userEvent.click(screen.getByRole("button", { name: "Enable structured output" }))

    await userEvent.click(screen.getByRole("button", { name: "Disable structured output" }))

    expect(employeeConfig(store)).not.toHaveProperty("output")
    expect(screen.getByRole("button", { name: "Enable structured output" })).toBeTruthy()
  })
})

describe("employee inspector json output field", () => {
  it("swaps the description input for a JSON shape textarea", async () => {
    const store = renderInspector()
    await userEvent.click(screen.getByRole("button", { name: "Enable structured output" }))

    await choose("Type", "json")

    expect(employeeConfig(store).output).toMatchObject({
      fields: { result: { type: "json", required: false } },
    })
    expect(screen.getByLabelText("Output field 1 example shape")).toBeTruthy()
    expect(screen.queryByLabelText("Output field 1 description")).toBeNull()
  })

  it("flags invalid JSON inline without dropping the draft text", async () => {
    const store = renderInspector()
    await userEvent.click(screen.getByRole("button", { name: "Enable structured output" }))
    await choose("Type", "json")

    fireEvent.change(screen.getByLabelText("Output field 1 example shape"), { target: { value: "{not json" } })

    expect(screen.getByText("Not valid JSON — the shape won't be enforced until this parses.")).toBeTruthy()
    expect(employeeConfig(store).output).toMatchObject({
      fields: { result: { type: "json", required: false, description: "{not json" } },
    })
  })

  it("accepts valid JSON with no inline error", async () => {
    const store = renderInspector()
    await userEvent.click(screen.getByRole("button", { name: "Enable structured output" }))
    await choose("Type", "json")

    fireEvent.change(screen.getByLabelText("Output field 1 example shape"), { target: { value: '{"a":1}' } })

    expect(screen.queryByText("Not valid JSON — the shape won't be enforced until this parses.")).toBeNull()
    expect(employeeConfig(store).output).toMatchObject({
      fields: { result: { type: "json", required: false, description: '{"a":1}' } },
    })
  })
})

describe("employee inspector timeout", () => {
  it("round-trips a blank timeout to undefined", () => {
    const store = renderInspector({ timeoutMinutes: 45 })
    const input = screen.getByLabelText("Timeout (minutes)") as HTMLInputElement

    expect(input.value).toBe("45")
    fireEvent.change(input, { target: { value: "" } })

    expect(input.value).toBe("")
    expect(employeeConfig(store)).not.toHaveProperty("timeoutMinutes")
  })

  it("writes timeout minutes as an integer", () => {
    const store = renderInspector()

    fireEvent.change(screen.getByLabelText("Timeout (minutes)"), { target: { value: "30" } })

    expect(employeeConfig(store).timeoutMinutes).toBe(30)
  })
})

function renderApproval(config: Record<string, unknown>) {
  const initial = structuredClone(definition)
  initial.nodes = [{ id: "gate", type: "approval", name: "Gate", config }]
  initial.ui.positions = { gate: { x: 0, y: 0 } }
  const store = createEditorStore(initial)
  store.getState().selectNode("gate")
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <EditorStoreContext.Provider value={store}>
        <Inspector />
      </EditorStoreContext.Provider>
    </QueryClientProvider>,
  )
  return store
}

function approvalConfig(store: ReturnType<typeof createEditorStore>) {
  return store.getState().nodes[0]!.data.node.config as Record<string, unknown>
}

describe("approval inspector operator-only gate", () => {
  it("reserves the gate and drops any approver, since the two contradict", () => {
    const store = renderApproval({ description: "Merge?", approver: { source: "fixed", value: "platform-lead" } })

    fireEvent.click(screen.getByLabelText("Only the operator may decide"))

    expect(approvalConfig(store)).toEqual({ description: "Merge?", operatorOnly: true })
    expect(screen.queryByLabelText("Approver (optional)")).toBeNull()
  })

  it("clears the flag entirely rather than writing operatorOnly: false", () => {
    const store = renderApproval({ description: "Merge?", operatorOnly: true })

    fireEvent.click(screen.getByLabelText("Only the operator may decide"))

    expect(approvalConfig(store)).not.toHaveProperty("operatorOnly")
    expect(screen.getByLabelText("Approver (optional)")).toBeTruthy()
  })
})
