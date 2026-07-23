import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom"
import { TodosIndexRedirect, legacyTodosRedirectTarget } from "../board/todos-index-redirect"

/* Slice 6 stage A — /todos redirects into the board surface (My requests) while
 * the legacy list stays reachable at /todos/list until the stage-C cutover.
 * The route arrangement mirrors main.tsx; the components are stand-ins. */

function BoardStub() {
  const { board } = useParams()
  return <div data-testid="board-page">{board}</div>
}

function Shell({ start }: { start: string }) {
  return (
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route path="/todos" element={<TodosIndexRedirect />} />
        <Route path="/todos/b/:board" element={<BoardStub />} />
        <Route path="/todos/list" element={<div data-testid="legacy-list">Legacy</div>} />
        <Route path="/todos/:todoId" element={<div data-testid="legacy-detail">Legacy detail</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe("legacyTodosRedirectTarget", () => {
  it("lands on My requests by default", () => {
    expect(legacyTodosRedirectTarget("")).toBe("/todos/b/my")
  })
  it("maps the needs lens to the Attention board", () => {
    expect(legacyTodosRedirectTarget("?view=needs")).toBe("/todos/b/attention")
  })
  it("keeps the people lens on the legacy list", () => {
    expect(legacyTodosRedirectTarget("?view=people")).toBe("/todos/list?view=people")
  })
  it("carries filter params through", () => {
    expect(legacyTodosRedirectTarget("?assignee=scout&view=needs")).toBe("/todos/b/attention?assignee=scout")
    expect(legacyTodosRedirectTarget("?department=platform")).toBe("/todos/b/my?department=platform")
  })
})

describe("/todos route arrangement", () => {
  it("redirects /todos to the My requests board", () => {
    render(<Shell start="/todos" />)
    expect(screen.getByTestId("board-page").textContent).toBe("my")
  })

  it("serves department boards at /todos/b/:board", () => {
    render(<Shell start="/todos/b/platform" />)
    expect(screen.getByTestId("board-page").textContent).toBe("platform")
  })

  it("keeps the legacy list reachable at /todos/list", () => {
    render(<Shell start="/todos/list" />)
    expect(screen.getByTestId("legacy-list")).toBeTruthy()
  })

  it("keeps the legacy detail route working (stage-B swaps its element)", () => {
    render(<Shell start="/todos/PLA-12" />)
    expect(screen.getByTestId("legacy-detail")).toBeTruthy()
  })

  it("static /todos/list is not shadowed by the :todoId param route", () => {
    render(<Shell start="/todos/list" />)
    expect(screen.queryByTestId("legacy-detail")).toBeNull()
  })
})
