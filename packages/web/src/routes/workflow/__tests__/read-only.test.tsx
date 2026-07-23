import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listWorkflowDefinitions = vi.fn()
const getWorkflowDefinition = vi.fn()
const listWorkflowRuns = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    listWorkflowDefinitionsV2: (...args: unknown[]) => listWorkflowDefinitions(...args),
    getWorkflowDefinitionV2: (...args: unknown[]) => getWorkflowDefinition(...args),
    listWorkflowRunsV2: (...args: unknown[]) => listWorkflowRuns(...args),
  },
}))
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => undefined }))

import WorkflowListPage from "../list"
import WorkflowPage from "../page"

function renderRoute(path: string) {
  const router = createMemoryRouter([
    { path: "/workflow", element: <WorkflowListPage /> },
    { path: "/workflow/:id", element: <WorkflowPage /> },
  ], { initialEntries: [path] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  listWorkflowDefinitions.mockReset()
  getWorkflowDefinition.mockReset()
  listWorkflowRuns.mockReset()
  listWorkflowRuns.mockResolvedValue({ items: [], nextCursor: null })
})

describe("read-only Workflows", () => {
  it("lists v2 definitions without edit actions", async () => {
    listWorkflowDefinitions.mockResolvedValue({
      items: [
        { id: "morning-digest", title: "Morning Digest", description: "Daily briefing", revision: 1, enabled: false, retiredAt: null, createdAt: "2026-07-23T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z" },
        { id: "plan-implement-verify", title: "Plan, implement, verify", description: null, revision: 1, enabled: true, retiredAt: null, createdAt: "2026-07-23T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z" },
      ],
      nextCursor: null,
    })
    getWorkflowDefinition.mockImplementation((id: string) => Promise.resolve({
      id,
      nodes: Array.from({ length: id === "morning-digest" ? 1 : 4 }),
      edges: Array.from({ length: id === "morning-digest" ? 0 : 4 }),
    }))

    renderRoute("/workflow")

    expect(await screen.findByText("Morning Digest")).toBeTruthy()
    expect(screen.getByText("1 node · 0 edges")).toBeTruthy()
    expect(screen.getByText("4 nodes · 4 edges")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /new workflow/i })).toBeNull()
  })

  it("shows a v2 definition graph as a read-only node and connection inventory", async () => {
    getWorkflowDefinition.mockResolvedValue({
      schemaVersion: 1,
      id: "morning-digest",
      title: "Morning Digest",
      description: "Daily briefing",
      revision: 1,
      enabled: false,
      retiredAt: null,
      createdAt: "2026-07-23T08:00:00.000Z",
      updatedAt: "2026-07-23T08:00:00.000Z",
      nodes: [
        { id: "trigger", type: "trigger", name: "Manual", config: { kind: "manual" } },
        { id: "writer", type: "employee", name: "Writer", config: { employee: { source: "fixed", value: "writer" }, prompt: "Write." } },
      ],
      edges: [
        { id: "start", from: { nodeId: "trigger", port: "out" }, to: { nodeId: "writer", port: "input" } },
      ],
      ui: { positions: { trigger: { x: 0, y: 0 }, writer: { x: 200, y: 0 } } },
    })

    renderRoute("/workflow/morning-digest")

    expect(await screen.findByText("Manual")).toBeTruthy()
    expect(screen.getByText("Writer")).toBeTruthy()
    expect(screen.getByText("Manual → Writer")).toBeTruthy()
    expect(await screen.findByText("No runs yet.")).toBeTruthy()
    expect(screen.queryByText("Editor")).toBeNull()
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull()
  })
})
