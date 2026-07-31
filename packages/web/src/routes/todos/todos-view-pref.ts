export type TodoView = "list" | "board"

export const TODO_VIEW_STORAGE_KEY = "jinn-todos-view"

export function loadTodoViewPreference(storage: Pick<Storage, "getItem"> = localStorage): TodoView {
  try {
    return storage.getItem(TODO_VIEW_STORAGE_KEY) === "board" ? "board" : "list"
  } catch {
    return "list"
  }
}

export function saveTodoViewPreference(
  view: TodoView,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(TODO_VIEW_STORAGE_KEY, view)
  } catch {
    // The preference is a convenience; private-mode storage can refuse it.
  }
}
