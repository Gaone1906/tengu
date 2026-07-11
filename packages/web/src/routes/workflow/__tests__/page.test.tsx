import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const getWorkflowDefinition = vi.fn()
const listWorkflows = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getWorkflowDefinition: (...args: unknown[]) => getWorkflowDefinition(...args),
    listWorkflows: (...args: unknown[]) => listWorkflows(...args),
  },
}))

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => undefined }))

vi.mock("../edit", () => ({
  WorkflowEditView: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => (
    <div data-testid="editor-stub">
      <button type="button" onClick={() => onDirtyChange?.(true)}>Make graph dirty</button>
      <button type="button" onClick={() => onDirtyChange?.(false)}>Discard graph edits</button>
    </div>
  ),
}))

vi.mock("../run-view", () => ({
  DefinitionRunView: () => <div data-testid="executions-stub">Executions</div>,
}))

import WorkflowPage from "../page"

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/workflow/sample?mode=edit"]}>
      <Routes>
        <Route path="/workflow/:id" element={<WorkflowPage />} />
        <Route path="/workflow" element={<div data-testid="workflow-list-stub">Workflow list</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("WorkflowPage dirty leave guards", () => {
  beforeEach(() => {
    getWorkflowDefinition.mockReset().mockResolvedValue({
      schemaVersion: 1,
      id: "sample",
      title: "Sample",
      version: 3,
      status: "active",
      nodes: [],
      edges: [],
    })
    listWorkflows.mockReset().mockResolvedValue({ workflows: [], evidenceConfigured: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps the dirty Editor open when the operator cancels a lens change", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    renderPage()
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Make graph dirty" }))

    fireEvent.click(screen.getAllByTestId("wf-mode-runs")[0])

    expect(confirm).toHaveBeenCalledWith("Discard unsaved workflow edits?")
    expect(screen.getByTestId("editor-stub")).toBeTruthy()
    expect(screen.queryByTestId("executions-stub")).toBeNull()
  })

  it("keeps the dirty Editor open when the operator cancels Back", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    renderPage()
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Make graph dirty" }))

    fireEvent.click(screen.getByTestId("wf-back"))

    expect(confirm).toHaveBeenCalledWith("Discard unsaved workflow edits?")
    expect(screen.getByTestId("editor-stub")).toBeTruthy()
    expect(screen.queryByTestId("workflow-list-stub")).toBeNull()
  })

  it("registers beforeunload while graph edits are dirty", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Make graph dirty" }))

    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it("removes the beforeunload guard after Discard clears dirty state", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Make graph dirty" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard graph edits" }))

    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })
})
