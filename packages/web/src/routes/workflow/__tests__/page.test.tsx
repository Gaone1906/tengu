import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
    onDirtyChange,
    onLeaveActionsChange,
  }: {
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
      <div data-testid="editor-stub">
        <button type="button" onClick={() => onDirtyChange?.(true)}>Make graph dirty</button>
        <button type="button" onClick={() => onDirtyChange?.(false)}>Discard graph edits</button>
      </div>
    )
  },
}))

vi.mock("../run-view", () => ({
  DefinitionRunView: () => <div data-testid="executions-stub">Executions</div>,
}))

import WorkflowPage from "../page"

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
  return { router, ...render(<RouterProvider router={router} />) }
}

async function makeDirty() {
  await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy())
  fireEvent.click(screen.getByRole("button", { name: "Make graph dirty" }))
}

async function expectLeaveDialog() {
  return await screen.findByRole("dialog", { name: "Unsaved workflow edits" })
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

  it.each([
    ["Back", ["/todos", "/workflow/sample?mode=edit"], 1, -1, "/todos"],
    ["Forward", ["/workflow/sample?mode=edit", "/todos"], 0, 1, "/todos"],
  ] as const)("blocks browser %s and resumes the original POP target", async (_direction, entries, initialIndex, delta, target) => {
    const { router } = renderPage({ entries: [...entries], initialIndex })
    await makeDirty()

    await router.navigate(delta)
    await expectLeaveDialog()
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/workflow/sample?mode=edit")

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(target))
  })

  it("uses the same Stay/Discard guard for the local Editor to Executions lens", async () => {
    renderPage()
    await makeDirty()

    fireEvent.click(screen.getAllByTestId("wf-mode-runs")[0])
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Stay" }))
    expect(screen.getByTestId("editor-stub")).toBeTruthy()
    expect(screen.queryByTestId("executions-stub")).toBeNull()

    fireEvent.click(screen.getAllByTestId("wf-mode-runs")[0])
    await expectLeaveDialog()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(screen.getByTestId("executions-stub")).toBeTruthy())
    expect(discardDraft).toHaveBeenCalledTimes(1)
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
