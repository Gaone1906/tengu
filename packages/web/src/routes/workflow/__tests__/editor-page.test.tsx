import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listWorkflowDefinitions = vi.fn()
const getWorkflowDefinition = vi.fn()
const listWorkflowRuns = vi.fn()
const createWorkflow = vi.fn()
const saveWorkflowDefinition = vi.fn()
const setWorkflowEnabled = vi.fn()

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message)
    }
  }
  class WorkflowValidationApiError extends ApiError {
    constructor(status: number, message: string, code: string | undefined, readonly issues: unknown[]) {
      super(status, message, code)
    }
  }
  return {
    ApiError,
    WorkflowValidationApiError,
    api: {
      listWorkflowDefinitionsV2: (...args: unknown[]) => listWorkflowDefinitions(...args),
      getWorkflowDefinitionV2: (...args: unknown[]) => getWorkflowDefinition(...args),
      listWorkflowRunsV2: (...args: unknown[]) => listWorkflowRuns(...args),
      createWorkflowV2: (...args: unknown[]) => createWorkflow(...args),
      saveWorkflowDefinitionV2: (...args: unknown[]) => saveWorkflowDefinition(...args),
      setWorkflowEnabledV2: (...args: unknown[]) => setWorkflowEnabled(...args),
      getOrg: () => Promise.resolve({ departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
    },
  }
})
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => undefined }))

import { WorkflowValidationApiError } from "@/lib/api"
import { DND_MIME } from "../editor/palette"
import WorkflowListPage from "../list"
import WorkflowPage from "../page"

const definition = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  revision: 3,
  enabled: false,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  nodes: [
    { id: "trigger", type: "trigger", name: "Kickoff", config: { kind: "manual" } },
    { id: "writer", type: "employee", name: "Writer", config: { prompt: "" } },
  ],
  edges: [{ id: "e1", from: { nodeId: "trigger", port: "success" }, to: { nodeId: "writer", port: "input" } }],
  ui: { positions: { trigger: { x: 0, y: 0 }, writer: { x: 400, y: 0 } } },
}

function renderRoute(path: string) {
  const router = createMemoryRouter([
    { path: "/workflow", element: <WorkflowListPage /> },
    { path: "/workflow/:id", element: <WorkflowPage /> },
  ], { initialEntries: [path] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkflowDefinition.mockResolvedValue(structuredClone(definition))
  listWorkflowRuns.mockResolvedValue({ items: [], nextCursor: null })
  listWorkflowDefinitions.mockResolvedValue({
    items: [{ id: "morning-digest", title: "Morning Digest", description: null, revision: 3, enabled: false, retiredAt: null, createdAt: definition.createdAt, updatedAt: definition.updatedAt }],
    nextCursor: null,
  })
})

describe("workflow editor surface", () => {
  it("creates a workflow from the list and opens its editor", async () => {
    createWorkflow.mockResolvedValue({ ...structuredClone(definition), id: "daily-report", title: "Daily Report", nodes: [], edges: [], ui: { positions: {} } })
    const router = renderRoute("/workflow")

    await userEvent.click(await screen.findByRole("button", { name: /new workflow/i }))
    await userEvent.type(screen.getByLabelText("Workflow title"), "Daily Report")
    await userEvent.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledWith({ id: "daily-report", title: "Daily Report" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflow/daily-report"))
  })

  it("opens the editor lens with palette, canvas nodes, and save state", async () => {
    renderRoute("/workflow/morning-digest")

    expect(await screen.findByText("Kickoff")).toBeTruthy()
    expect(screen.getByText("Writer")).toBeTruthy()
    expect(screen.getByText("Add step")).toBeTruthy()
    expect(screen.getByText("Saved")).toBeTruthy()
    expect(screen.getByRole("switch", { name: /enable workflow/i })).toBeTruthy()
  })

  it("creates a condition node without crashing the editor", async () => {
    // Regression: the condition inspector's node-id selector returned a fresh
    // array per snapshot, which loops useSyncExternalStore (React #185) and
    // replaced the whole editor with the router error page.
    renderRoute("/workflow/morning-digest")
    await screen.findByText("Kickoff")

    const canvas = document.querySelector(".react-flow")
    if (!canvas) throw new Error("canvas not mounted")
    fireEvent.drop(canvas, {
      dataTransfer: { getData: (type: string) => (type === DND_MIME ? "condition" : "") },
    })

    // The new node mounts selected — its inspector must open, editor intact.
    expect(await screen.findByRole("button", { name: /add route/i })).toBeTruthy()
    expect(screen.getByText("Kickoff")).toBeTruthy()
  })

  it("switches to the runs lens without leaving the page", async () => {
    listWorkflowRuns.mockResolvedValue({
      items: [{
        id: "run-1", workflowId: "morning-digest", workflowTitle: "Morning Digest",
        definitionRevision: 3, status: "completed",
        trigger: { nodeId: "trigger", kind: "manual" },
        startedAt: "2026-07-22T08:00:00.000Z", endedAt: "2026-07-22T08:01:00.000Z",
        currentOrFailingNode: null,
      }],
      nextCursor: null,
    })
    renderRoute("/workflow/morning-digest")

    await userEvent.click(await screen.findByRole("button", { name: "Runs" }))
    expect(await screen.findByText("Completed")).toBeTruthy()
    expect(screen.getByText("run-1")).toBeTruthy()
  })

  it("renders the server's verdicts when enabling fails validation", async () => {
    setWorkflowEnabled.mockRejectedValue(new WorkflowValidationApiError(422, "Workflow definition is invalid.", "invalid-definition", [
      { code: "missing-end-path", message: "A Trigger must have a directed path to an End." },
      { code: "dead-node", message: "Reachable non-End node has no path to an End.", nodeId: "writer" },
    ]))
    renderRoute("/workflow/morning-digest")

    await userEvent.click(await screen.findByRole("switch", { name: /enable workflow/i }))

    expect(await screen.findByText("Not ready to enable")).toBeTruthy()
    expect(screen.getByText(/directed path to an End/)).toBeTruthy()
    expect(screen.getByText(/Writer —/)).toBeTruthy()
  })

  it("enables through the switch with the acknowledged revision", async () => {
    setWorkflowEnabled.mockResolvedValue({ ...structuredClone(definition), enabled: true, revision: 4 })
    renderRoute("/workflow/morning-digest")

    await userEvent.click(await screen.findByRole("switch", { name: /enable workflow/i }))

    await waitFor(() => expect(setWorkflowEnabled).toHaveBeenCalledWith("morning-digest", true, 3))
    expect(await screen.findByRole("switch", { name: /disable workflow/i })).toBeTruthy()
  })
})
