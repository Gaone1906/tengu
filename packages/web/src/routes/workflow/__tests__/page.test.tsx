import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryRouter,
  useLocation,
  useNavigate,
} from "react-router-dom"

const getWorkflowDefinition = vi.fn()
const listWorkflows = vi.fn()
const saveDraft = vi.fn<() => Promise<boolean>>()
const discardDraft = vi.fn()

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
  WorkflowEditView: ({
    workflowId,
    onDirtyChange,
    onLeaveActionsChange,
  }: {
    workflowId: string
    onDirtyChange?: (dirty: boolean) => void
    onLeaveActionsChange?: (actions: { save: () => Promise<boolean>; discard: () => void } | null) => void
  }) => {
    useEffect(() => {
      onLeaveActionsChange?.({
        save: async () => {
          const saved = await saveDraft()
          if (saved) onDirtyChange?.(false)
          return saved
        },
        discard: () => {
          discardDraft()
          onDirtyChange?.(false)
        },
      })
      return () => onLeaveActionsChange?.(null)
    }, [onDirtyChange, onLeaveActionsChange])
    return (
      <div data-testid="editor-stub" data-workflow-id={workflowId}>
        <button type="button" onClick={() => onDirtyChange?.(true)}>Make graph dirty</button>
        <button type="button" onClick={() => onDirtyChange?.(false)}>Discard graph edits</button>
      </div>
    )
  },
}))

vi.mock("../run-view", () => ({
  DefinitionRunView: ({ workflowId, initialLive }: { workflowId: string; initialLive?: boolean }) => (
    <div data-testid="executions-stub" data-workflow-id={workflowId} data-initial-live={String(Boolean(initialLive))}>
      Executions
    </div>
  ),
}))

import WorkflowPage from "../page"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

function Destination() {
  const location = useLocation()
  return <div data-testid="destination">{location.pathname}{location.search}</div>
}

function TestShell() {
  const navigate = useNavigate()
  return (
    <>
      <nav>
        <Link to="/todos">Sidebar Todos</Link>
        <Link to="/workflow">Breadcrumb Workflows</Link>
        <Link to="/settings?from=search">Global search Settings</Link>
        <Link to="/workflow/other?mode=edit">Other workflow definition</Link>
        <button type="button" onClick={() => navigate("/org?source=command")}>Programmatic Org</button>
        <button type="button" onClick={() => navigate("/workflow/other?mode=runs")}>Programmatic other executions</button>
      </nav>
      <Outlet />
    </>
  )
}

function renderPage({
  entries = ["/workflow/sample?mode=edit"],
  initialIndex,
}: {
  entries?: string[]
  initialIndex?: number
} = {}) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <TestShell />,
      children: [
        { path: "workflow/:id", element: <WorkflowPage /> },
        { path: "workflow", element: <Destination /> },
        { path: "todos", element: <Destination /> },
        { path: "settings", element: <Destination /> },
        { path: "org", element: <Destination /> },
      ],
    },
  ], { initialEntries: entries, initialIndex })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { router, ...render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>) }
}

async function makeDirty() {
  await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy())
  fireEvent.click(screen.getByRole("button", { name: "Make graph dirty" }))
}

async function expectLeaveDialog() {
  return await screen.findByRole("dialog", { name: "Unsaved workflow edits" })
}

function expectEditor(workflowId: string) {
  const editor = screen.getByTestId("editor-stub")
  expect(editor.getAttribute("data-workflow-id")).toBe(workflowId)
  expect(screen.queryByTestId("executions-stub")).toBeNull()
}

function expectExecutions(workflowId: string, initialLive = false) {
  const executions = screen.getByTestId("executions-stub")
  expect(executions.getAttribute("data-workflow-id")).toBe(workflowId)
  expect(executions.getAttribute("data-initial-live")).toBe(String(initialLive))
  expect(screen.queryByTestId("editor-stub")).toBeNull()
}

async function expectWorkflowTitle(title: string) {
  await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy())
}

describe("WorkflowPage dirty leave guards", () => {
  beforeEach(() => {
    getWorkflowDefinition.mockReset().mockImplementation(async (id: string) => ({
      schemaVersion: 1,
      id,
      title: id === "sample" ? "Sample" : "Other",
      version: 3,
      status: "active",
      nodes: [],
      edges: [],
    }))
    listWorkflows.mockReset().mockResolvedValue({ workflows: [], evidenceConfigured: true })
    saveDraft.mockReset().mockResolvedValue(true)
    discardDraft.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ["sidebar link", "Sidebar Todos", "/todos"],
    ["breadcrumb link", "Breadcrumb Workflows", "/workflow"],
    ["global search link", "Global search Settings", "/settings?from=search"],
    ["workflow definition link", "Other workflow definition", "/workflow/other?mode=edit"],
  ])("blocks a dirty Editor %s and Discard resumes its exact target", async (_kind, label, target) => {
    const { router } = renderPage()
    await makeDirty()

    fireEvent.click(screen.getByRole("link", { name: label }))
    await expectLeaveDialog()
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/sample?mode=edit")

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(target))
    expect(discardDraft).toHaveBeenCalledTimes(1)
  })

  it("Stay cancels programmatic navigation without losing its intended target on retry", async () => {
    const { router } = renderPage()
    await makeDirty()

    const trigger = screen.getByRole("button", { name: "Programmatic Org" })
    trigger.focus()
    fireEvent.click(trigger)
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Stay" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved workflow edits" })).toBeNull())
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/sample?mode=edit")
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(screen.getByRole("button", { name: "Programmatic Org" }))
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/org?source=command"))
  })

  it("Save proceeds to the exact blocked target only after a successful save", async () => {
    saveDraft.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { router } = renderPage()
    await makeDirty()

    fireEvent.click(screen.getByRole("link", { name: "Global search Settings" }))
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1))
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/sample?mode=edit")
    expect(screen.getByRole("dialog", { name: "Unsaved workflow edits" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/settings?from=search"))
    expect(saveDraft).toHaveBeenCalledTimes(2)
  })

  it("Discard commits a cross-workflow URL and its Executions lens together", async () => {
    const { router } = renderPage()
    await makeDirty()

    fireEvent.click(screen.getByRole("button", { name: "Programmatic other executions" }))
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/other?mode=runs"))
    await waitFor(() => expectExecutions("other"))
    await expectWorkflowTitle("Other")
  })

  it("Save commits a cross-workflow live URL and its live Executions seed together", async () => {
    const { router } = renderPage()
    await makeDirty()

    await act(async () => { await router.navigate("/workflow/other?mode=live") })
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/other?mode=live"))
    await waitFor(() => expectExecutions("other", true))
    await expectWorkflowTitle("Other")
  })

  it("Stay preserves the current workflow lens before a cross-workflow retry", async () => {
    const { router } = renderPage()
    await makeDirty()

    fireEvent.click(screen.getByRole("button", { name: "Programmatic other executions" }))
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Stay" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved workflow edits" })).toBeNull())
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/sample?mode=edit")
    expectEditor("sample")

    fireEvent.click(screen.getByRole("button", { name: "Programmatic other executions" }))
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expectExecutions("other"))
  })

  it("synchronizes a committed same-workflow search-only lens transition", async () => {
    const { router } = renderPage()
    await makeDirty()

    await act(async () => { await router.navigate("/workflow/sample?mode=runs") })
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/sample?mode=runs"))
    await waitFor(() => expectExecutions("sample"))
  })

  it.each([
    ["Back", ["/todos", "/workflow/sample?mode=edit"], 1, -1, "/todos"],
    ["Forward", ["/workflow/sample?mode=edit", "/todos"], 0, 1, "/todos"],
  ] as const)("blocks browser %s and resumes the original POP target", async (_direction, entries, initialIndex, delta, target) => {
    const { router } = renderPage({ entries: [...entries], initialIndex })
    await makeDirty()

    await act(async () => { await router.navigate(delta) })
    await expectLeaveDialog()
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/sample?mode=edit")

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(target))
  })

  it.each([
    ["Back", ["/workflow/other?mode=runs", "/workflow/sample?mode=edit"], 1, -1],
    ["Forward", ["/workflow/sample?mode=edit", "/workflow/other?mode=runs"], 0, 1],
  ] as const)("browser %s commits the POP workflow and lens together", async (_direction, entries, initialIndex, delta) => {
    const { router } = renderPage({ entries: [...entries], initialIndex })
    await makeDirty()

    await act(async () => { await router.navigate(delta) })
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/other?mode=runs"))
    await waitFor(() => expectExecutions("other"))
    await expectWorkflowTitle("Other")
  })

  it.each([
    ["/workflow/other?mode=edit", "edit", false],
    ["/workflow/other?mode=runs", "runs", false],
    ["/workflow/other?mode=live", "runs", true],
  ] as const)("direct URL %s renders its requested lens", async (entry, expectedMode, initialLive) => {
    const { router } = renderPage({ entries: [entry] })
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(entry))
    if (expectedMode === "edit") {
      await waitFor(() => expectEditor("other"))
    } else {
      await waitFor(() => expectExecutions("other", initialLive))
    }
    await expectWorkflowTitle("Other")
  })

  it("uses the same Stay/Discard guard for the local Editor to Executions lens", async () => {
    renderPage()
    await makeDirty()

    const initiatingModeControl = screen.getAllByTestId("wf-mode-runs")[0]
    initiatingModeControl.focus()
    fireEvent.click(initiatingModeControl)
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Stay" }))
    expect(screen.getByTestId("editor-stub")).toBeTruthy()
    expect(screen.queryByTestId("executions-stub")).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(initiatingModeControl))

    fireEvent.click(screen.getAllByTestId("wf-mode-runs")[0])
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(screen.getByTestId("executions-stub")).toBeTruthy())
    expect(discardDraft).toHaveBeenCalledTimes(1)
  })

  it.each(["Save", "Discard"] as const)("%s route commit never restores a disconnected origin", async (action) => {
    const { router } = renderPage()
    await makeDirty()
    const origin = screen.getByRole("button", { name: "Make graph dirty" })
    const originFocus = vi.spyOn(origin, "focus")
    origin.focus()
    originFocus.mockClear()

    await act(async () => { await router.navigate("/workflow/other?mode=runs") })
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: action }))

    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/other?mode=runs"))
    await waitFor(() => expectExecutions("other"))
    await expectWorkflowTitle("Other")
    expect(origin.isConnected).toBe(false)
    expect(document.activeElement).not.toBe(origin)
    expect(originFocus).not.toHaveBeenCalled()
  })

  it("uses the same failed/successful Save contract for the Executions lens target", async () => {
    saveDraft.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderPage()
    await makeDirty()

    fireEvent.click(screen.getAllByTestId("wf-mode-runs")[0])
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("editor-stub")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.getByTestId("executions-stub")).toBeTruthy())
  })

  it("registers beforeunload while graph edits are dirty", async () => {
    renderPage()
    await makeDirty()

    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it("removes the beforeunload guard after the editor clears dirty state", async () => {
    renderPage()
    await makeDirty()
    fireEvent.click(screen.getByRole("button", { name: "Discard graph edits" }))

    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })
})
