import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom"
import { TodosIndexRedirect, legacyTodosRedirectTarget } from "../board/todos-index-redirect"

/* Slice 6 stage C — /todos IS the board surface (the index redirects into
 * My requests) and /todos/:todoId is the task page. The legacy list route is
 * gone; its lenses map onto the boards that superseded them. The route
 * arrangement mirrors main.tsx; the components are stand-ins. */

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
        <Route path="/todos/:todoId" element={<div data-testid="task-page">Task</div>} />
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
  it("maps the retired people lens to Everything (superseded by department boards)", () => {
    expect(legacyTodosRedirectTarget("?view=people")).toBe("/todos/b/everything")
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

  it("serves the task page at /todos/:todoId", () => {
    render(<Shell start="/todos/PLA-12" />)
    expect(screen.getByTestId("task-page")).toBeTruthy()
  })

  it("a legacy people-lens deep link lands on the Everything board, never a dead route", () => {
    render(<Shell start="/todos?view=people" />)
    expect(screen.getByTestId("board-page").textContent).toBe("everything")
  })
})
