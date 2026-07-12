import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TodoApiError, type WorkItemEditRequest } from "@/lib/api"
import { loadTodoJournal, persistTodoJournal } from "../todo-private-state"
import {
  useTodoDraft,
  type TodoEditableDraft,
  type TodoRemoteSnapshot,
} from "../use-todo-draft"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const first: TodoEditableDraft = {
  title: "First todo",
  body: "Original body",
  assignee: null,
  department: null,
  priority: 0,
}

function snapshot(draft: TodoEditableDraft, version: number): TodoRemoteSnapshot {
  return { draft, version }
}

function successful(remote = snapshot(first, 2), replayed = false) {
  return { remote, replayed }
}

function throwJournalState(state: "prepared" | "dispatched") {
  const original = Storage.prototype.setItem
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === "jinn:todo-draft-journal:v2" && String(value).includes(`\"state\":\"${state}\"`)) {
      throw new DOMException("storage unavailable", "QuotaExceededError")
    }
    return original.call(this, key, value)
  })
}

describe("useTodoDraft conditional state machine", () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it("exact-replays two lost responses and a remount before any GET", async () => {
    const calls: WorkItemEditRequest[] = []
    const save = vi.fn(async (request: WorkItemEditRequest) => {
      calls.push(structuredClone(request))
      if (calls.length < 3) throw new TypeError("response lost")
      return successful(snapshot({ ...first, title: "B" }, 8), true)
    })
    const loadRemote = vi.fn()
    const mounted = renderHook(() => useTodoDraft({
      id: "lost-twice",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote,
    }))

    act(() => {
      mounted.result.current.change("title", "B")
      mounted.result.current.save({ title: "B" })
    })
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))
    act(() => mounted.result.current.retry())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))
    mounted.unmount()

    const recovered = renderHook(() => useTodoDraft({
      id: "lost-twice",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote,
    }))
    await waitFor(() => expect(recovered.result.current.isAcknowledged).toBe(true))

    expect(calls).toHaveLength(3)
    expect(calls[1]).toEqual(calls[0])
    expect(calls[2]).toEqual(calls[0])
    expect(calls[0]).toMatchObject({ patch: { title: "B" }, expectedVersion: 7 })
    expect(loadRemote).not.toHaveBeenCalled()
  })

  it("does not PATCH until a prepared request is durably readable", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "B" }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "prepared-durability", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "B"))
    const storage = throwJournalState("prepared")
    act(() => result.current.save({ title: "B" }))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(save).not.toHaveBeenCalled()
    expect(loadTodoJournal("prepared-durability")?.request).toBeUndefined()

    storage.mockRestore()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("does not PATCH when the dispatched lifecycle write is not durable", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "B" }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "dispatch-durability", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "B"))
    const storage = throwJournalState("dispatched")
    act(() => result.current.save({ title: "B" }))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(save).not.toHaveBeenCalled()
    expect(loadTodoJournal("dispatch-durability")?.request?.state).toBe("prepared")

    storage.mockRestore()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("keeps A1 immutable while edits arrive and mints A2 only after A1 acknowledgement", async () => {
    const a1 = deferred<ReturnType<typeof successful>>()
    const a2 = deferred<ReturnType<typeof successful>>()
    const save = vi.fn()
      .mockReturnValueOnce(a1.promise)
      .mockReturnValueOnce(a2.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "queue", initial: first, serverVersion: 7, save }))

    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
      result.current.change("title", "C")
      result.current.change("priority", 3)
      result.current.save(result.current.unsavedPatch())
    })

    const a1Request = structuredClone(save.mock.calls[0]![0]) as WorkItemEditRequest
    expect(a1Request).toMatchObject({ patch: { title: "B" }, expectedVersion: 7 })
    expect(loadTodoJournal("queue")?.request?.patch).toEqual({ title: "B" })
    expect(loadTodoJournal("queue")?.patch).toEqual({ title: "C", priority: 3 })
    expect(save).toHaveBeenCalledTimes(1)

    await act(async () => a1.resolve(successful(snapshot({ ...first, title: "B" }, 8))))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    const a2Request = save.mock.calls[1]![0] as WorkItemEditRequest
    expect(a2Request).toMatchObject({ patch: { title: "C", priority: 3 }, expectedVersion: 8 })
    expect(a2Request.idempotencyKey).not.toBe(a1Request.idempotencyKey)
    expect(result.current.isAcknowledged).toBe(false)

    await act(async () => a2.resolve(successful(snapshot({ ...first, title: "C", priority: 3 }, 9))))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
  })

  it("does not mint A2 when replay returns a later same-field row", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Remote R" }, 9), true))
    const { result } = renderHook(() => useTodoDraft({ id: "later-row", initial: first, serverVersion: 7, save }))

    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
      result.current.change("title", "C")
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))

    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.draft.title).toBe("C")
    expect(result.current.conflictFields).toEqual(["title"])
    expect(result.current.isAcknowledged).toBe(false)
  })

  it("clears latest intent when a replay's current row already equals it", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "C" }, 9), true))
    const { result } = renderHook(() => useTodoDraft({ id: "later-equal", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
      result.current.change("title", "C")
    })
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.draft.title).toBe("C")
  })

  it("adopts unrelated remote changes after acknowledgement", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "B", priority: 3 }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "remote-merge", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(result.current.draft).toEqual({ ...first, title: "B", priority: 3 })
  })

  it("loads an authoritative numeric version before the first PATCH", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "B" }, 5)))
    const loadRemote = vi.fn().mockResolvedValue(snapshot(first, 4))
    const { result } = renderHook(() => useTodoDraft({ id: "unknown-version", initial: first, save, loadRemote }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(loadRemote).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedVersion: 4, patch: { title: "B" } })
  })

  it("never treats a legacy timestamp marker as CAS authority", async () => {
    persistTodoJournal("legacy-version", {
      revision: 1,
      patch: { title: "B" },
      baseline: { title: first.title },
      baselineVersion: "2026-07-12T05:00:00.000Z",
    })
    const loadRemote = vi.fn().mockResolvedValue(snapshot(first, 4))
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "B" }, 5)))
    const { result } = renderHook(() => useTodoDraft({ id: "legacy-version", initial: first, save, loadRemote }))
    act(() => result.current.save(result.current.unsavedPatch()))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(loadRemote).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedVersion: 4 })
  })

  it.each([undefined, 0])("does not PATCH when GET returns version %s", async (version) => {
    const save = vi.fn()
    const loadRemote = vi.fn().mockResolvedValue({ draft: first, version })
    const { result } = renderHook(() => useTodoDraft({ id: `bad-version-${version}`, initial: first, save, loadRemote }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(save).not.toHaveBeenCalled()
    expect(result.current.isAcknowledged).toBe(false)
  })

  it("retries an unchanged definitive failure with the exact request", async () => {
    const failure = new TodoApiError(403, "private", "WORK_ITEM_APPROVAL_PENDING")
    const save = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "B" }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "definitive-retry", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.error).toBe(failure))
    const firstRequest = structuredClone(save.mock.calls[0]![0])
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[1]![0]).toEqual(firstRequest)
  })

  it("keeps a recovered definitive failure inert until explicit Retry", async () => {
    const failure = new TodoApiError(403, "private", "WORK_ITEM_APPROVAL_PENDING")
    const save = vi.fn().mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "B" }, 8)))
    const firstMount = renderHook(() => useTodoDraft({ id: "failed-inert", initial: first, serverVersion: 7, save }))
    act(() => {
      firstMount.result.current.change("title", "B")
      firstMount.result.current.save({ title: "B" })
    })
    await waitFor(() => expect(firstMount.result.current.status).toBe("error"))
    firstMount.unmount()

    const recovered = renderHook(() => useTodoDraft({ id: "failed-inert", initial: first, serverVersion: 7, save }))
    await act(async () => Promise.resolve())
    expect(save).toHaveBeenCalledTimes(1)
    expect(recovered.result.current.status).toBe("error")
    act(() => recovered.result.current.retry())
    await waitFor(() => expect(recovered.result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("retires a definitive failed request after an edit and mints a new key", async () => {
    const failure = new TodoApiError(403, "private", "WORK_ITEM_APPROVAL_PENDING")
    const save = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "C" }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "definitive-edit", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    const oldKey = (save.mock.calls[0]![0] as WorkItemEditRequest).idempotencyKey
    act(() => {
      result.current.change("title", "C")
      result.current.save({ title: "C" })
    })
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[1]![0]).toMatchObject({ patch: { title: "C" }, expectedVersion: 7 })
    expect((save.mock.calls[1]![0] as WorkItemEditRequest).idempotencyKey).not.toBe(oldKey)
  })

  it("clears a definitive failure on exact revert and never resurrects it", async () => {
    const failure = new TodoApiError(403, "private", "WORK_ITEM_APPROVAL_PENDING")
    const save = vi.fn().mockRejectedValue(failure)
    const mounted = renderHook(() => useTodoDraft({ id: "failed-revert", initial: first, serverVersion: 7, save }))
    act(() => {
      mounted.result.current.change("title", "B")
      mounted.result.current.save({ title: "B" })
    })
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))
    act(() => mounted.result.current.change("title", first.title))
    expect(mounted.result.current.isAcknowledged).toBe(true)
    expect(mounted.result.current.error).toBeNull()
    expect(loadTodoJournal("failed-revert")).toBeNull()
    mounted.unmount()
    const recovered = renderHook(() => useTodoDraft({ id: "failed-revert", initial: first, serverVersion: 7, save }))
    expect(recovered.result.current.hasUnsaved).toBe(false)
    act(() => recovered.result.current.retry())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each([
    [409, "TODO_VERSION_CONFLICT", true],
    [412, "WORK_ITEM_VERSION_CONFLICT", true],
    [409, "TODO_IDEMPOTENCY_CONFLICT", false],
    [409, undefined, false],
    [412, undefined, false],
    [428, "TODO_PRECONDITION_REQUIRED", false],
    [400, "TODO_INVALID_VERSION", false],
    [400, "TODO_INVALID_PATCH", false],
  ] as const)("preserves typed %s/%s and classifies explicit version codes only", async (status, code, conflict) => {
    const failure = new TodoApiError(status, "private diagnostic", code, 11)
    const save = vi.fn().mockRejectedValue(failure)
    const { result } = renderHook(() => useTodoDraft({ id: `typed-${status}-${code}`, initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.error).toBe(failure)
    expect(result.current.recoveredConflict).toBe(conflict)
  })

  it("reloads remote by discarding the conflicted request and intent", async () => {
    const save = vi.fn().mockRejectedValue(new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8))
    const { result } = renderHook(() => useTodoDraft({ id: "reload", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    act(() => result.current.reloadRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(result.current.draft.title).toBe("Remote")
    expect(result.current.isAcknowledged).toBe(true)
    expect(loadTodoJournal("reload")).toBeNull()
  })

  it("rebases unrelated fields with a new conditional request", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "B", priority: 3 }, 9)))
    const { result } = renderHook(() => useTodoDraft({ id: "rebase", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const oldKey = (save.mock.calls[0]![0] as WorkItemEditRequest).idempotencyKey
    act(() => result.current.rebaseRemote(snapshot({ ...first, priority: 3 }, 8)))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[1]![0]).toMatchObject({ expectedVersion: 8, patch: { title: "B" } })
    expect((save.mock.calls[1]![0] as WorkItemEditRequest).idempotencyKey).not.toBe(oldKey)
    expect(result.current.draft.priority).toBe(3)
  })

  it("keeps conflict visibility while a safe Rebase request is pending", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const pending = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockRejectedValueOnce(conflict).mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "rebase-pending", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    act(() => result.current.rebaseRemote(snapshot({ ...first, priority: 3 }, 8)))
    expect(result.current.recoveredConflict).toBe(true)
    expect(result.current.conflictFields).toEqual(["title"])
    expect(result.current.isAcknowledged).toBe(false)
    await act(async () => pending.resolve(successful(snapshot({ ...first, title: "Local", priority: 3 }, 9))))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(result.current.recoveredConflict).toBe(false)
  })

  it("exposes same-field conflicts during rebase without PATCHing", async () => {
    const failure = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValue(failure)
    const { result } = renderHook(() => useTodoDraft({ id: "rebase-same", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    act(() => result.current.rebaseRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.draft.title).toBe("Local")
    expect(result.current.conflictFields).toEqual(["title"])
    expect(result.current.isAcknowledged).toBe(false)
  })

  it("overwrites only after a fresh version with a new key and keeps a second conflict blocked", async () => {
    const firstConflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const secondConflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 9)
    const save = vi.fn().mockRejectedValueOnce(firstConflict).mockRejectedValueOnce(secondConflict)
    const { result } = renderHook(() => useTodoDraft({ id: "overwrite", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const oldKey = (save.mock.calls[0]![0] as WorkItemEditRequest).idempotencyKey
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(result.current.isAcknowledged).toBe(false)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.error).toBe(secondConflict))
    expect(save.mock.calls[1]![0]).toMatchObject({ expectedVersion: 8, patch: { title: "Local" } })
    expect((save.mock.calls[1]![0] as WorkItemEditRequest).idempotencyKey).not.toBe(oldKey)
    expect(result.current.recoveredConflict).toBe(true)
    expect(result.current.isAcknowledged).toBe(false)
  })

  it("keeps conflict visibility while Overwrite is pending", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const pending = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockRejectedValueOnce(conflict).mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "overwrite-pending", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(result.current.recoveredConflict).toBe(true)
    expect(result.current.conflictFields).toEqual(["title"])
    expect(result.current.isAcknowledged).toBe(false)
    await act(async () => pending.resolve(successful(snapshot({ ...first, title: "Local" }, 9))))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(result.current.recoveredConflict).toBe(false)
  })

  it("keeps conflict visibility when the Overwrite request definitively fails", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const rejected = new TodoApiError(403, "private", "WORK_ITEM_APPROVAL_PENDING")
    const save = vi.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(rejected)
    const { result } = renderHook(() => useTodoDraft({ id: "overwrite-rejected", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(result.current.error).toBe(rejected))
    expect(result.current.recoveredConflict).toBe(true)
    expect(result.current.conflictFields).toEqual(["title"])
    expect(result.current.isAcknowledged).toBe(false)
  })

  it("keeps the old conflict blocked when conflict-to-A2 persistence fails", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "Local" }, 9)))
    const { result } = renderHook(() => useTodoDraft({ id: "conflict-storage", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const oldRequest = structuredClone(save.mock.calls[0]![0])
    const original = Storage.prototype.setItem
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "jinn:todo-draft-journal:v2") throw new DOMException("storage unavailable", "QuotaExceededError")
      return original.call(this, key, value)
    })
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.recoveredConflict).toBe(true)
    expect(result.current.conflictFields).toEqual(["title"])
    const preparationError = result.current.error
    storage.mockRestore()
    act(() => result.current.retry())
    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBe(preparationError)
    expect(loadTodoJournal("conflict-storage")?.request).toMatchObject(oldRequest)

    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("keeps close blocked through an edit made while A1 is saving and A2 is pending", async () => {
    const a1 = deferred<ReturnType<typeof successful>>()
    const a2 = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(a2.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "close", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
      result.current.change("title", "C")
      result.current.save(result.current.unsavedPatch())
    })
    expect(result.current.isAcknowledged).toBe(false)
    await act(async () => a1.resolve(successful(snapshot({ ...first, title: "B" }, 8))))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(result.current.isAcknowledged).toBe(false)
    await act(async () => a2.resolve(successful(snapshot({ ...first, title: "C" }, 9))))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
  })

  it("atomically replaces A1 with A2 without a clear-then-add storage gap", async () => {
    const a1 = deferred<ReturnType<typeof successful>>()
    const a2 = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(a2.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "atomic-a2", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
      result.current.change("title", "C")
    })
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    const removeItem = vi.spyOn(Storage.prototype, "removeItem")
    setItem.mockClear()
    removeItem.mockClear()

    await act(async () => a1.resolve(successful(snapshot({ ...first, title: "B" }, 8))))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(removeItem).not.toHaveBeenCalled()
    // One atomic A1→A2 install, then one prepared→dispatched lifecycle write.
    expect(setItem).toHaveBeenCalledTimes(2)
    expect(loadTodoJournal("atomic-a2")?.request).toMatchObject({ patch: { title: "C" }, expectedVersion: 8 })
    setItem.mockRestore()
    removeItem.mockRestore()
    await act(async () => a2.resolve(successful(snapshot({ ...first, title: "C" }, 9))))
  })

  it("isolates an item switch from a late response without clearing the old journal", async () => {
    const pending = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(
      ({ id, title }) => useTodoDraft({ id, initial: { ...first, title }, serverVersion: 7, save }),
      { initialProps: { id: "one", title: first.title } },
    )
    act(() => {
      result.current.change("title", "First changed")
      result.current.save({ title: "First changed" })
    })
    rerender({ id: "two", title: "Second todo" })
    await act(async () => pending.resolve(successful(snapshot({ ...first, title: "First changed" }, 8))))
    expect(result.current.draft.title).toBe("Second todo")
    expect(loadTodoJournal("one")?.request).toBeDefined()
  })

  it("recovers only dirty fields over fresh data and preserves storage privacy/cap", () => {
    const save = vi.fn()
    const firstMount = renderHook(() => useTodoDraft({ id: "private-multitab", initial: first, serverVersion: 7, save }))
    act(() => firstMount.result.current.change("title", "User-authored wi_text"))
    firstMount.unmount()
    const recovered = renderHook(() => useTodoDraft({
      id: "private-multitab",
      initial: { ...first, priority: 3 },
      serverVersion: 8,
      save,
    }))
    expect(recovered.result.current.draft).toEqual({ ...first, title: "User-authored wi_text", priority: 3 })
    expect(recovered.result.current.unsavedPatch()).toEqual({ title: "User-authored wi_text" })

    const persisted = Array.from({ length: sessionStorage.length }, (_, index) => {
      const key = sessionStorage.key(index) ?? ""
      return `${key}\n${sessionStorage.getItem(key) ?? ""}`
    }).join("\n")
    expect(persisted).toContain("User-authored wi_text")
    expect(persisted).not.toContain("private-multitab")
  })

  it("uses the current server version for requestless recovered intent", async () => {
    persistTodoJournal("requestless-current", {
      revision: 1,
      patch: { title: "Local" },
      baseline: { title: first.title },
      baselineVersion: 7,
    })
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Local", priority: 3 }, 9)))
    const { result } = renderHook(() => useTodoDraft({
      id: "requestless-current",
      initial: { ...first, priority: 3 },
      serverVersion: 8,
      save,
    }))
    act(() => result.current.save(result.current.unsavedPatch()))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedVersion: 8, patch: { title: "Local" } })
  })

  it("persists a GET-discovered conflict across remount at the same version", async () => {
    const loadRemote = vi.fn().mockResolvedValue(snapshot({ ...first, title: "Remote" }, 8))
    const save = vi.fn()
    const firstMount = renderHook(() => useTodoDraft({ id: "get-conflict", initial: first, save, loadRemote }))
    act(() => {
      firstMount.result.current.change("title", "Local")
      firstMount.result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(firstMount.result.current.recoveredConflict).toBe(true))
    firstMount.unmount()

    const recovered = renderHook(() => useTodoDraft({
      id: "get-conflict",
      initial: { ...first, title: "Remote" },
      serverVersion: 8,
      save,
      loadRemote,
    }))
    expect(recovered.result.current.recoveredConflict).toBe(true)
    expect(recovered.result.current.conflictFields).toEqual(["title"])
    act(() => recovered.result.current.retry())
    expect(save).not.toHaveBeenCalled()
  })

  it("retries requestless version acquisition without unconditional PATCH", async () => {
    const loadRemote = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(snapshot(first, 8))
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Local" }, 9)))
    const { result } = renderHook(() => useTodoDraft({ id: "acquire-retry", initial: first, save, loadRemote }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(save).not.toHaveBeenCalled()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(loadRemote).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedVersion: 8 })
  })

  it("does not acknowledge a malformed remote snapshot", async () => {
    const save = vi.fn().mockResolvedValue({
      remote: { draft: { title: "Only a title" }, version: 8 },
      replayed: false,
    } as never)
    const { result } = renderHook(() => useTodoDraft({ id: "malformed-remote", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.isAcknowledged).toBe(false)
    expect(loadTodoJournal("malformed-remote")?.request).toBeDefined()
  })

  it("acknowledges an exact clean revert without transport", () => {
    const save = vi.fn()
    const { result } = renderHook(() => useTodoDraft({ id: "clean-revert", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Temporary")
      result.current.change("title", first.title)
    })
    expect(result.current.unsavedPatch()).toEqual({})
    expect(result.current.isAcknowledged).toBe(true)
    expect(result.current.status).toBe("idle")
    expect(loadTodoJournal("clean-revert")).toBeNull()
  })

  it("recovers an active request without replacing its sent fingerprint", async () => {
    persistTodoJournal("recovered-active", {
      revision: 2,
      patch: { title: "C", priority: 3 },
      baseline: { title: first.title, priority: 0 },
      baselineVersion: 7,
      uncertainFields: ["title"],
      request: {
        revision: 1,
        patch: { title: "B" },
        expectedVersion: 7,
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
        state: "uncertain",
      },
    })
    const save = vi.fn()
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "B" }, 8), true))
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "C", priority: 3 }, 9)))
    const { result } = renderHook(() => useTodoDraft({ id: "recovered-active", initial: first, serverVersion: 7, save }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[0]![0]).toEqual({
      patch: { title: "B" },
      expectedVersion: 7,
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    })
    expect(save.mock.calls[1]![0]).toMatchObject({ patch: { title: "C", priority: 3 }, expectedVersion: 8 })
    expect(result.current.isAcknowledged).toBe(true)
  })
})
