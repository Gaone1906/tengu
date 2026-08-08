import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { NavRibbon } from "../pill-nav"
import { NAV_ITEMS } from "@/lib/nav"

const prefetchRoute = vi.fn()
vi.mock("@/lib/route-prefetch", () => ({ prefetchRoute: (...args: unknown[]) => prefetchRoute(...args) }))

vi.mock("@/hooks/use-workspaces", () => ({
  useWorkspaces: () => ({ data: [] }),
  useStartWorkspace: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
}))

vi.mock("@/hooks/use-session-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-session-telemetry")>()
  return { ...actual, useSessionTelemetry: () => ({ data: null, phase: "ready" as const, now: Date.now() }) }
})

function renderRibbon(props: { listOpen: boolean; path?: string }) {
  return render(
    <MemoryRouter initialEntries={[props.path ?? "/"]}>
      <NavRibbon listOpen={props.listOpen} onToggleList={vi.fn()} />
    </MemoryRouter>,
  )
}

describe("NavRibbon", () => {
  it("renders a brand-only top slot (no fold toggle) when mounted without list props", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/org"]}>
        <NavRibbon />
      </MemoryRouter>,
    )
    // The global (non-chat) rail has no list to fold → no toggle button.
    expect(screen.queryByLabelText("Show chats")).toBeNull()
    expect(screen.queryByLabelText("Hide chats")).toBeNull()
    // The top slot is a brand mark that links home.
    expect(container.querySelector('a[href="/"]')).toBeTruthy()
  })

  it("renders the toggle with a state-aware label", () => {
    const { rerender } = renderRibbon({ listOpen: true })
    expect(screen.getByLabelText("Hide chats")).toBeTruthy()
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <NavRibbon listOpen={false} onToggleList={vi.fn()} />
      </MemoryRouter>,
    )
    const toggle = screen.getByLabelText("Show chats")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  })

  it("renders every nav item as a labelled link", () => {
    renderRibbon({ listOpen: true })
    for (const item of NAV_ITEMS) {
      const link = screen.getByLabelText(item.label)
      expect(link.getAttribute("href")).toBe(item.href)
    }
  })

  it("prefetches a route when its nav link is hovered", () => {
    renderRibbon({ listOpen: true })
    fireEvent.pointerEnter(screen.getByLabelText("Todos"))
    expect(prefetchRoute).toHaveBeenCalledWith("/todos")
  })

  it("marks the active route with aria-current and a non-accent fill", () => {
    renderRibbon({ listOpen: true, path: "/org" })
    const active = screen.getByLabelText("Organization")
    expect(active.getAttribute("aria-current")).toBe("page")
    // Selection is accent-independent: a soft --fill-secondary, never --accent.
    expect(active.className).toContain("fill-secondary")
    expect(active.className).not.toContain("--accent")
    // A non-active item carries no aria-current.
    expect(screen.getByLabelText("Cron").getAttribute("aria-current")).toBeNull()
  })

  it("keeps the workspace launcher in the bottom cluster immediately above Theme", () => {
    const { container } = renderRibbon({ listOpen: true })
    const launcher = screen.getByLabelText("Switch workspace")
    const theme = screen.getByLabelText(/Theme:/)
    expect(launcher.parentElement).toBe(theme.parentElement)
    expect(launcher.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(launcher.parentElement?.className).toContain("mt-auto")
    expect(container.querySelector("nav")?.lastElementChild).toBe(launcher.parentElement)
  })

  // Chat icon is OPEN-ONLY: reveals a collapsed list while already on /chat,
  // navigates otherwise, never closes.
  describe("Chat icon open-only behavior", () => {
    function renderWith(opts: { listOpen: boolean; path: string; onToggleList: () => void }) {
      render(
        <MemoryRouter initialEntries={[opts.path]}>
          <NavRibbon listOpen={opts.listOpen} onToggleList={opts.onToggleList} />
        </MemoryRouter>,
      )
      return screen.getByLabelText("Chat")
    }

    it("reveals the list when on /chat with the list hidden", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).toHaveBeenCalledTimes(1)
    })

    it("is a no-op when the list is already open on /chat", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: true, path: "/", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).not.toHaveBeenCalled()
    })

    it("navigates (never toggles) when not on /chat", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/org", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).not.toHaveBeenCalled()
    })

    it("does not hijack modified clicks (new tab / window)", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/", onToggleList })
      fireEvent.click(chat, { metaKey: true })
      expect(onToggleList).not.toHaveBeenCalled()
    })
  })
})
