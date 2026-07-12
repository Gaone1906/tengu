import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FilterBar } from "../filter-bar"

const originalMatchMedia = window.matchMedia
let mobileListener: ((event: MediaQueryListEvent) => void) | undefined
function setMobile(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { mobileListener = listener }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => {
  mobileListener = undefined
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

describe("Todo progressive filters", () => {
  it("keeps search and one Filter affordance visible, with power filters disclosed on demand", () => {
    setMobile(false)
    render(
      <FilterBar
        filters={{ status: "open" }}
        onChange={vi.fn()}
        employees={[]}
        departments={["platform"]}
        byName={new Map()}
        onPeopleView={vi.fn()}
      />,
    )

    expect(screen.getByRole("searchbox", { name: "Search todos" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Filter todos" })).toBeTruthy()
    expect(screen.queryByTestId("filter-person")).toBeNull()
    expect(screen.queryByTestId("filter-source")).toBeNull()

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter todos" }), { button: 0, pointerType: "mouse" })
    expect(screen.getByText("Person")).toBeTruthy()
    expect(screen.getByText("Department")).toBeTruthy()
    expect(screen.getByText("Source")).toBeTruthy()
    expect(screen.getByText("Date")).toBeTruthy()
    expect(screen.getByText("View by person")).toBeTruthy()
    expect(screen.queryByRole("dialog", { name: "Filter todos" })).toBeNull()
  })

  it("uses an accessible bottom sheet instead of a popover on mobile", () => {
    setMobile(true)
    render(
      <FilterBar
        filters={{ status: "open" }}
        onChange={vi.fn()}
        employees={[]}
        departments={["platform"]}
        byName={new Map()}
        onPeopleView={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Filter todos" }))
    const sheet = screen.getByRole("dialog", { name: "Filter todos" })
    expect(sheet.className).toContain("bottom-0")
    expect(screen.getByRole("button", { name: "Status" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Person" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Department" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Date" })).toBeTruthy()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("switches to the bottom sheet when a resize crosses the mobile breakpoint", () => {
    setMobile(false)
    render(
      <FilterBar filters={{ status: "open" }} onChange={vi.fn()} employees={[]} departments={[]} byName={new Map()} />,
    )

    act(() => mobileListener?.({ matches: true } as MediaQueryListEvent))
    fireEvent.click(screen.getByRole("button", { name: "Filter todos" }))
    expect(screen.getByRole("dialog", { name: "Filter todos" })).toBeTruthy()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("closes the mobile sheet and restores trigger focus across 390 → 844 → 390", async () => {
    setMobile(true)
    render(
      <FilterBar filters={{ status: "open" }} onChange={vi.fn()} employees={[]} departments={[]} byName={new Map()} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Filter todos" }))
    expect(screen.getByRole("dialog", { name: "Filter todos" })).toBeTruthy()

    act(() => mobileListener?.({ matches: false } as MediaQueryListEvent))
    expect(screen.queryByRole("dialog", { name: "Filter todos" })).toBeNull()
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter todos" }))

    act(() => mobileListener?.({ matches: true } as MediaQueryListEvent))
    expect(screen.queryByRole("dialog", { name: "Filter todos" })).toBeNull()
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter todos" }))

    act(() => mobileListener?.({ matches: false } as MediaQueryListEvent))
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter todos" }))

    act(() => mobileListener?.({ matches: true } as MediaQueryListEvent))
    await act(async () => Promise.resolve())
    expect(screen.queryByRole("dialog", { name: "Filter todos" })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter todos" }))
    expect(document.activeElement).not.toBe(document.body)
  })

  it("keeps active filters visible and individually removable", () => {
    setMobile(false)
    const onChange = vi.fn()
    render(
      <FilterBar
        filters={{ status: "blocked", department: "platform", q: "roadmap" }}
        onChange={onChange}
        employees={[]}
        departments={["platform"]}
        byName={new Map()}
      />,
    )

    expect(screen.getByRole("button", { name: "Remove Status: Blocked" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove Department: Platform" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Remove Department: Platform" }))
    expect(onChange).toHaveBeenCalledWith({ status: "blocked", q: "roadmap", department: undefined })
  })

  it("treats search as search, not a filter badge", () => {
    setMobile(false)
    render(
      <FilterBar
        filters={{ status: "open", q: "roadmap" }}
        onChange={vi.fn()}
        onSearchChange={vi.fn()}
        employees={[]}
        departments={[]}
        byName={new Map()}
      />,
    )

    expect(screen.getByRole("button", { name: "Filter todos" }).textContent).not.toContain("1")
    expect(screen.queryByLabelText("Active filters")).toBeNull()
  })

  it("cancels a stale search debounce when history or filters change", () => {
    vi.useFakeTimers()
    setMobile(false)
    const onSearchChange = vi.fn()
    const { rerender } = render(
      <FilterBar
        filters={{ status: "blocked", department: "platform" }}
        onChange={vi.fn()}
        onSearchChange={onSearchChange}
        employees={[]}
        departments={["platform"]}
        byName={new Map()}
      />,
    )

    fireEvent.change(screen.getByRole("searchbox", { name: "Search todos" }), { target: { value: "stale" } })
    rerender(
      <FilterBar
        filters={{ status: "open" }}
        onChange={vi.fn()}
        onSearchChange={onSearchChange}
        employees={[]}
        departments={["platform"]}
        byName={new Map()}
      />,
    )
    act(() => vi.advanceTimersByTime(300))

    expect(onSearchChange).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search todos" }).value).toBe("")
    vi.useRealTimers()
  })
})
