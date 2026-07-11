import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FilterBar } from "../filter-bar"

const originalMatchMedia = window.matchMedia
function setMobile(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia }))

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

  it("keeps active filters visible and individually removable", () => {
    setMobile(false)
    const onChange = vi.fn()
    render(
      <FilterBar
        filters={{ status: "blocked", department: "platform", q: "JIN-142" }}
        onChange={onChange}
        employees={[]}
        departments={["platform"]}
        byName={new Map()}
      />,
    )

    expect(screen.getByRole("button", { name: "Remove Status: Blocked" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove Department: Platform" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Remove Department: Platform" }))
    expect(onChange).toHaveBeenCalledWith({ status: "blocked", q: "JIN-142", department: undefined })
  })
})
