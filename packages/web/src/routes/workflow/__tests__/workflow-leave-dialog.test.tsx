import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Outlet, RouterProvider, createMemoryRouter, useNavigate } from "react-router-dom"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const saveDraft = vi.fn<() => Promise<boolean>>()

vi.mock("@/lib/api", () => ({
  api: {
    getWorkflowDefinition: async (id: string) => ({
      schemaVersion: 1,
      id,
      title: id,
      version: 1,
      status: "active",
      nodes: [],
      edges: [],
    }),
    listWorkflows: async () => ({ workflows: [], evidenceConfigured: true }),
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
        save: saveDraft,
        discard: () => onDirtyChange?.(false),
      })
      return () => onLeaveActionsChange?.(null)
    }, [onDirtyChange, onLeaveActionsChange])
    return <button type="button" onClick={() => onDirtyChange?.(true)}>Make dirty</button>
  },
}))

vi.mock("../run-view", () => ({ DefinitionRunView: () => <div>Executions</div> }))

import WorkflowPage from "../page"

function Shell() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" onClick={() => navigate("/workflow/other?mode=runs")}>Programmatic destination</button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">More destinations</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => navigate("/workflow/other?mode=runs")}>Other workflow executions</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Outlet />
    </>
  )
}

function renderDirtyPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    {
      path: "/",
      element: <Shell />,
      children: [{ path: "workflow/:id", element: <WorkflowPage /> }],
    },
  ], { initialEntries: ["/workflow/sample?mode=edit"] })
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...view, router }
}

async function makeDirty() {
  fireEvent.click(await screen.findByRole("button", { name: "Make dirty" }))
}

async function openFromProgrammaticButton() {
  const trigger = screen.getByRole("button", { name: "Programmatic destination" })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole("dialog", { name: "Unsaved workflow edits" })
  return { dialog, trigger }
}

describe("Workflow leave dialog accessibility", () => {
  beforeEach(() => {
    saveDraft.mockReset().mockResolvedValue(true)
    vi.stubGlobal("PointerEvent", MouseEvent)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("moves focus inside, loops Tab, and makes the background inert", async () => {
    const { container } = renderDirtyPage()
    await makeDirty()
    const { dialog } = await openFromProgrammaticButton()

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay" })))
    expect(container.getAttribute("aria-hidden")).toBe("true")
    expect(document.body.style.pointerEvents).toBe("none")

    const save = screen.getByRole("button", { name: "Save" })
    save.focus()
    fireEvent.keyDown(save, { key: "Tab" })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay" }))

    const stay = screen.getByRole("button", { name: "Stay" })
    stay.focus()
    fireEvent.keyDown(stay, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(save)

    await act(async () => {
      const overlay = document.querySelector<HTMLElement>("[data-slot=dialog-overlay]")
      expect(overlay).toBeTruthy()
      fireEvent.pointerDown(overlay!)
      fireEvent.click(overlay!)
    })
    expect(screen.getByRole("dialog", { name: "Unsaved workflow edits" })).toBe(dialog)

    screen.getByRole("button", { name: "Programmatic destination", hidden: true }).focus()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it("treats Escape as Stay and restores the initiating control", async () => {
    renderDirtyPage()
    await makeDirty()
    const { trigger } = await openFromProgrammaticButton()

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved workflow edits" })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.getByRole("button", { name: "Make dirty" })).toBeTruthy()
  })

  it("restores focus to a nested menu trigger after Stay", async () => {
    renderDirtyPage()
    await makeDirty()
    const trigger = screen.getByRole("button", { name: "More destinations" })

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    })
    const item = await screen.findByRole("menuitem", { name: "Other workflow executions" })
    await act(async () => {
      item.focus()
      fireEvent.click(item)
    })
    await screen.findByRole("dialog", { name: "Unsaved workflow edits" })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stay" }))
    })

    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it.each([
    [390, false],
    [1440, true],
  ])("keeps a failed Save modal at %ipx with reduced motion=%s", async (width, reducedMotion) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reducedMotion : width <= 767,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    saveDraft.mockResolvedValue(false)
    const { container } = renderDirtyPage()
    await makeDirty()
    const { dialog } = await openFromProgrammaticButton()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await Promise.resolve()
    })

    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("dialog", { name: "Unsaved workflow edits" })).toBe(dialog)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(container.getAttribute("aria-hidden")).toBe("true")
  })
})
