import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  api: {
    getOrg: () => Promise.resolve({
      departments: [],
      employees: [],
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

beforeEach(() => {
  vi.restoreAllMocks()
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
