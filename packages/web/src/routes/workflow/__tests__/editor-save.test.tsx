import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const saveWorkflowDefinition = vi.fn()

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message)
    }
  }
  class WorkflowValidationApiError extends ApiError {
    constructor(status: number, message: string, code: string | undefined, readonly issues: unknown[]) {
      super(status, message, code)
    }
  }
  return {
    ApiError,
    WorkflowValidationApiError,
    api: { saveWorkflowDefinitionV2: (...args: unknown[]) => saveWorkflowDefinition(...args) },
  }
})

import type { WorkflowDefinitionV2Wire } from "@/lib/api"
import { ApiError } from "@/lib/api"
import { useAutosave } from "../editor/editor"
import { createEditorStore, EditorStoreContext, type EditorStoreApi } from "../editor/store"

const definition: WorkflowDefinitionV2Wire = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  revision: 3,
  enabled: false,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  nodes: [{ id: "trigger", type: "trigger", name: "Manual", config: { kind: "manual" } }],
  edges: [],
  ui: { positions: { trigger: { x: 0, y: 0 } } },
}

function Harness({ store }: { store: EditorStoreApi }) {
  useAutosave(store)
  return null
}

function mount(store: EditorStoreApi) {
  return render(
    <EditorStoreContext value={store}>
      <Harness store={store} />
    </EditorStoreContext>,
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  saveWorkflowDefinition.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("autosave", () => {
  it("debounces edits into one PUT carrying the acknowledged revision", async () => {
    saveWorkflowDefinition.mockResolvedValue({ ...definition, revision: 4, updatedAt: "2026-07-23T09:00:00.000Z" })
    const store = createEditorStore(structuredClone(definition))
    mount(store)

    act(() => {
      store.getState().renameNode("trigger", "Kickoff")
      store.getState().renameNode("trigger", "Kickoff!")
    })
    expect(saveWorkflowDefinition).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    await act(async () => {})

    expect(saveWorkflowDefinition).toHaveBeenCalledTimes(1)
    const [id, wire, expectedRevision] = saveWorkflowDefinition.mock.calls[0]!
    expect(id).toBe("morning-digest")
    expect(expectedRevision).toBe(3)
    expect(wire.nodes[0].name).toBe("Kickoff!")
    expect(store.getState().meta.revision).toBe(4)
    expect(store.getState().save.state).toBe("saved")
  })

  it("marks a 409 as a conflict and stops autosaving until reload", async () => {
    saveWorkflowDefinition.mockRejectedValue(new ApiError(409, "revision conflict"))
    const store = createEditorStore(structuredClone(definition))
    mount(store)

    act(() => store.getState().renameNode("trigger", "Kickoff"))
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    await act(async () => {})

    expect(store.getState().save.state).toBe("conflict")
    saveWorkflowDefinition.mockClear()

    act(() => store.getState().renameNode("trigger", "Another edit"))
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(saveWorkflowDefinition).not.toHaveBeenCalled()

    act(() => store.getState().applyDefinition({ ...structuredClone(definition), revision: 9 }))
    expect(store.getState().meta.revision).toBe(9)
    expect(store.getState().save.state).toBe("saved")
  })

  it("surfaces other failures as a retryable error state", async () => {
    saveWorkflowDefinition.mockRejectedValue(new ApiError(500, "boom"))
    const store = createEditorStore(structuredClone(definition))
    mount(store)

    act(() => store.getState().renameNode("trigger", "Kickoff"))
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    await act(async () => {})

    expect(store.getState().save.state).toBe("error")
  })
})
