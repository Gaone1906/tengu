import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FilterBar } from "../filter-bar"

const listLabels = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: { ...actual.api, listLabels: (...args: unknown[]) => listLabels(...args) },
  }
})

/** FilterBar reads the label registry (board mode) — render inside a client. */
function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = (node: React.ReactElement) => <QueryClientProvider client={client}>{node}</QueryClientProvider>
  const result = rtlRender(wrap(ui))
  return { ...result, rerender: (next: React.ReactElement) => result.rerender(wrap(next)) }
}

const originalMatchMedia = window.matchMedia
let mobileListener: ((event: MediaQueryListEvent) => void) | undefined
function setMobile(matches: boolean, reducedMotion = false) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : query === "(prefers-reduced-motion: reduce)" ? reducedMotion : false,
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
  vi.clearAllMocks()
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

describe("the board filter row (mock geometry — stage-A review F1)", () => {
  it("renders value chips left (Assignee · Label · Due), the ⋯ menu, and the compact right search", () => {
    setMobile(false)
    listLabels.mockResolvedValue({ labels: [] })
    render(
      <FilterBar
        filters={{ status: "open" }}
        onChange={vi.fn()}
        employees={[]}
        departments={[]}
        byName={new Map()}
        hideStatus
        board
      />,
    )
    expect(screen.getByTestId("filter-chip-assignee").textContent).toContain("Assignee")
    expect(screen.getByTestId("filter-chip-label").textContent).toContain("Label")
    expect(screen.getByTestId("filter-chip-due").textContent).toContain("Due")
    expect(screen.getByTestId("filter-chip-more")).toBeTruthy()
    expect(screen.getByRole("searchbox", { name: "Search todos" })).toBeTruthy()
    // The heavy legacy affordance is gone in board mode.
    expect(screen.queryByRole("button", { name: "Filter todos" })).toBeNull()
  })

  it("the Due chip sets the due window and turns accent with its value", () => {
    setMobile(false)
    listLabels.mockResolvedValue({ labels: [] })
    const onChange = vi.fn()
    const { rerender } = render(
      <FilterBar filters={{ status: "open" }} onChange={onChange} employees={[]} departments={[]} byName={new Map()} hideStatus board />,
    )
    const chip = screen.getByTestId("filter-chip-due")
    fireEvent.pointerDown(chip, { button: 0, pointerType: "mouse" })
    fireEvent.click(chip)
    fireEvent.click(screen.getByText("Due this week"))
    expect(onChange).toHaveBeenCalledWith({ status: "open", due: "week", q: undefined })
    rerender(
      <FilterBar filters={{ status: "open", due: "week" }} onChange={onChange} employees={[]} departments={[]} byName={new Map()} hideStatus board />,
    )
    expect(screen.getByTestId("filter-chip-due").textContent).toContain("Due this week")
  })

  it("the Label chip lists the registry and filters by label name", async () => {
    setMobile(false)
    listLabels.mockResolvedValue({
      labels: [{ id: "lbl_1", name: "infra", color: "#5B9BD5", department: null, createdAt: "2026-07-01" }],
    })
    const onChange = vi.fn()
    render(
      <FilterBar filters={{ status: "open" }} onChange={onChange} employees={[]} departments={[]} byName={new Map()} hideStatus board />,
    )
    const chip = screen.getByTestId("filter-chip-label")
    fireEvent.pointerDown(chip, { button: 0, pointerType: "mouse" })
    fireEvent.click(chip)
    fireEvent.click(await screen.findByText("infra"))
    expect(onChange).toHaveBeenCalledWith({ status: "open", label: "infra", q: undefined })
  })

  it("hides Department behind ⋯ on a department board and surfaces set overflow dimensions as removable chips", () => {
    setMobile(false)
    listLabels.mockResolvedValue({ labels: [] })
    const onChange = vi.fn()
    render(
      <FilterBar
        filters={{ status: "open", source: "cron" }}
        onChange={onChange}
        employees={[]}
        departments={[]}
        byName={new Map()}
        hideStatus
        hideDepartment
        board
      />,
    )
    expect(screen.getByRole("button", { name: "Remove Cron" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Remove Cron" }))
    expect(onChange).toHaveBeenCalledWith({ status: "open", source: undefined, q: undefined })
  })
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

  it.each([
    ["normal motion", false],
    ["reduced motion", true],
  ])("keeps a closed sheet closed and transfers its focused trigger across breakpoints with %s", async (_label, reducedMotion) => {
    setMobile(true, reducedMotion)
    render(
      <FilterBar filters={{ status: "open" }} onChange={vi.fn()} employees={[]} departments={[]} byName={new Map()} />,
    )

    const mobileTrigger = screen.getByRole("button", { name: "Filter todos" })
    mobileTrigger.focus()
    fireEvent.click(mobileTrigger)
    expect(screen.getByRole("dialog", { name: "Filter todos" })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Filter todos" }), { key: "Escape" })
    await act(async () => Promise.resolve())
    expect(screen.queryByRole("dialog", { name: "Filter todos" })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter todos" }))

    act(() => mobileListener?.({ matches: false } as MediaQueryListEvent))
    await act(async () => Promise.resolve())
    expect(screen.queryByRole("dialog", { name: "Filter todos" })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter todos" }))
    expect(document.activeElement).not.toBe(document.body)

    act(() => mobileListener?.({ matches: true } as MediaQueryListEvent))
    await act(async () => Promise.resolve())
    expect(screen.queryByRole("dialog", { name: "Filter todos" })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter todos" }))
    expect(document.activeElement).not.toBe(document.body)
  })

  it.each([
    ["normal motion", false],
    ["reduced motion", true],
  ])("does not steal unrelated Search focus across repeated breakpoints with %s", async (_label, reducedMotion) => {
    setMobile(true, reducedMotion)
    render(
      <FilterBar filters={{ status: "open" }} onChange={vi.fn()} employees={[]} departments={[]} byName={new Map()} />,
    )

    const search = screen.getByRole("searchbox", { name: "Search todos" })
    search.focus()
    expect(document.activeElement).toBe(search)

    for (const matches of [false, true, false, true]) {
      act(() => mobileListener?.({ matches } as MediaQueryListEvent))
      await act(async () => Promise.resolve())
      expect(screen.queryByRole("dialog", { name: "Filter todos" })).toBeNull()
      expect(document.activeElement).toBe(search)
      expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Filter todos" }))
    }
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
