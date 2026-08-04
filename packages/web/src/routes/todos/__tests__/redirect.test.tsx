import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom"
import { NAV_ITEMS } from "@/lib/nav"

/* GRS-021d — the Kanban→Todos rename: nav points at /todos, and the old
 * /kanban path redirects so existing links/bookmarks keep working. */

function Shell({ start }: { start: string }) {
  return (
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route path="/todos" element={<div data-testid="todos-page">Todos</div>} />
        <Route path="/kanban" element={<Navigate to="/todos" replace />} />
      </Routes>
    </MemoryRouter>
  )
}

describe("Todos nav + redirect", () => {
  it("nav exposes Todos at /todos and no longer exposes /kanban", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href)
    expect(hrefs).toContain("/todos")
    expect(hrefs).not.toContain("/kanban")
    expect(NAV_ITEMS.find((i) => i.href === "/todos")?.label).toBe("Todos")
  })

  it("hides Notes from the shared desktop order while disabled", () => {
    expect(NAV_ITEMS.slice(0, 4).map((item) => item.href)).toEqual([
      "/",
      "/todos",
      "/workflow",
      "/experiments",
    ])
  })

  it("redirects the old /kanban path to /todos", () => {
    render(<Shell start="/kanban" />)
    expect(screen.getByTestId("todos-page")).toBeTruthy()
  })

  it("serves /todos directly", () => {
    render(<Shell start="/todos" />)
    expect(screen.getByTestId("todos-page")).toBeTruthy()
  })
})
