import { beforeEach, describe, expect, it } from "vitest"
import {
  TODO_VIEW_STORAGE_KEY,
  loadTodoViewPreference,
  saveTodoViewPreference,
} from "../todos-view-pref"

describe("Todos view preference", () => {
  beforeEach(() => localStorage.clear())

  it.each([null, "", "grid", "{not-json"])("resolves %j to list", (stored) => {
    if (stored !== null) localStorage.setItem(TODO_VIEW_STORAGE_KEY, stored)
    expect(loadTodoViewPreference()).toBe("list")
  })

  it("persists Board for every Todos board to read on the next mount", () => {
    saveTodoViewPreference("board")
    expect(localStorage.getItem("jinn-todos-view")).toBe("board")
    expect(loadTodoViewPreference()).toBe("board")
  })
})
