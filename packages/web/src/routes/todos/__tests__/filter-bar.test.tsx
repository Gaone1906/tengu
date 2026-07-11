import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FilterBar } from "../filter-bar"

describe("Todo progressive filters", () => {
  it("keeps search and one Filter affordance visible, with power filters disclosed on demand", () => {
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
  })

  it("keeps active filters visible and individually removable", () => {
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
