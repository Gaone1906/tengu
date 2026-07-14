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

function testTodoId(label: string): string {
  if (/^[A-Z]{3}-[1-9][0-9]*$/.test(label)) return label
  let hash = 2166136261
  for (const char of label) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `JIN-${(hash >>> 0) + 1}`
}

function throwJournalState(state: "prepared" | "dispatched" | "failed") {
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
      id: "JIN-137",
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
      id: "JIN-137",
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-144", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "B"))
    const storage = throwJournalState("prepared")
    act(() => result.current.save({ title: "B" }))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(save).not.toHaveBeenCalled()
    expect(loadTodoJournal("JIN-144")?.request).toBeUndefined()

    storage.mockRestore()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("does not PATCH when the dispatched lifecycle write is not durable", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "B" }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-128", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "B"))
    const storage = throwJournalState("dispatched")
    act(() => result.current.save({ title: "B" }))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(save).not.toHaveBeenCalled()
    expect(loadTodoJournal("JIN-128")?.request?.state).toBe("prepared")

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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-146", initial: first, serverVersion: 7, save }))

    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
      result.current.change("title", "C")
      result.current.change("priority", 3)
      result.current.save(result.current.unsavedPatch())
    })

    const a1Request = structuredClone(save.mock.calls[0]![0]) as WorkItemEditRequest
    expect(a1Request).toMatchObject({ patch: { title: "B" }, expectedVersion: 7 })
    expect(loadTodoJournal("JIN-146")?.request?.patch).toEqual({ title: "B" })
    expect(loadTodoJournal("JIN-146")?.patch).toEqual({ title: "C", priority: 3 })
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-135", initial: first, serverVersion: 7, save }))

    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
      result.current.change("title", "C")
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    expect(result.current.conflictMode).toBe("same-field")

    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.draft.title).toBe("C")
    expect(result.current.conflictFields).toEqual(["title"])
    expect(result.current.isAcknowledged).toBe(false)
  })

  it("clears latest intent when a replay's current row already equals it", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "C" }, 9), true))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-134", initial: first, serverVersion: 7, save }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-158", initial: first, serverVersion: 7, save }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-168", initial: first, save, loadRemote }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(loadRemote).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedVersion: 4, patch: { title: "B" } })
  })

  it("never treats a legacy timestamp marker as CAS authority", async () => {
    persistTodoJournal("JIN-136", {
      revision: 1,
      patch: { title: "B" },
      baseline: { title: first.title },
      baselineVersion: "2026-07-12T05:00:00.000Z",
    })
    const loadRemote = vi.fn().mockResolvedValue(snapshot(first, 4))
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "B" }, 5)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-136", initial: first, save, loadRemote }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-127", initial: first, serverVersion: 7, save }))
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
    const firstMount = renderHook(() => useTodoDraft({ id: "JIN-130", initial: first, serverVersion: 7, save }))
    act(() => {
      firstMount.result.current.change("title", "B")
      firstMount.result.current.save({ title: "B" })
    })
    await waitFor(() => expect(firstMount.result.current.status).toBe("error"))
    firstMount.unmount()

    const recovered = renderHook(() => useTodoDraft({ id: "JIN-130", initial: first, serverVersion: 7, save }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-126", initial: first, serverVersion: 7, save }))
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
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-131", initial: first, serverVersion: 7, save }))
    act(() => {
      mounted.result.current.change("title", "B")
      mounted.result.current.save({ title: "B" })
    })
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))
    act(() => mounted.result.current.change("title", first.title))
    expect(mounted.result.current.isAcknowledged).toBe(true)
    expect(mounted.result.current.error).toBeNull()
    expect(loadTodoJournal("JIN-131")).toBeNull()
    mounted.unmount()
    const recovered = renderHook(() => useTodoDraft({ id: "JIN-131", initial: first, serverVersion: 7, save }))
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
    const { result } = renderHook(() => useTodoDraft({ id: testTodoId(`typed-${status}-${code}`), initial: first, serverVersion: 7, save }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-154", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    act(() => result.current.reloadRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(result.current.draft.title).toBe("Remote")
    expect(result.current.isAcknowledged).toBe(true)
    expect(loadTodoJournal("JIN-154")).toBeNull()
  })

  it("rebases unrelated fields with a new conditional request", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "B", priority: 3 }, 9)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-147", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const oldKey = (save.mock.calls[0]![0] as WorkItemEditRequest).idempotencyKey
    act(() => result.current.rebaseRemote(snapshot({ ...first, priority: 3 }, 8)))
    expect(result.current.conflictMode).toBe("reconciling")
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[1]![0]).toMatchObject({ expectedVersion: 8, patch: { title: "B" } })
    expect((save.mock.calls[1]![0] as WorkItemEditRequest).idempotencyKey).not.toBe(oldKey)
    expect(result.current.draft.priority).toBe(3)
  })

  it("keeps conflict visibility while a safe Rebase request is pending", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const pending = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockRejectedValueOnce(conflict).mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-150", initial: first, serverVersion: 7, save }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-151", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    act(() => result.current.rebaseRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.draft.title).toBe("Local")
    expect(result.current.conflictFields).toEqual(["title"])
    expect(result.current.conflictMode).toBe("same-field")
    expect(result.current.isAcknowledged).toBe(false)
  })

  it("overwrites only after a fresh version with a new key and keeps a second conflict blocked", async () => {
    const firstConflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const secondConflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 9)
    const save = vi.fn().mockRejectedValueOnce(firstConflict).mockRejectedValueOnce(secondConflict)
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-140", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const oldKey = (save.mock.calls[0]![0] as WorkItemEditRequest).idempotencyKey
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(result.current.conflictMode).toBe("reconciling")
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-141", initial: first, serverVersion: 7, save }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-142", initial: first, serverVersion: 7, save }))
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

  it("rehydrates conflict provenance after an Overwrite A2 fails", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const rejected = new TodoApiError(403, "private", "WORK_ITEM_APPROVAL_PENDING")
    const save = vi.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(rejected)
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-143", initial: first, serverVersion: 7, save }))
    act(() => {
      mounted.result.current.change("title", "Local")
      mounted.result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(mounted.result.current.recoveredConflict).toBe(true))
    act(() => mounted.result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(mounted.result.current.error).toBe(rejected))
    expect(loadTodoJournal("JIN-143")?.conflictFields).toEqual(["title"])
    mounted.unmount()

    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-143",
      initial: { ...first, title: "Remote" },
      serverVersion: 8,
      save,
    }))
    expect(recovered.result.current.recoveredConflict).toBe(true)
    expect(recovered.result.current.conflictFields).toEqual(["title"])
    expect(recovered.result.current.conflictMode).toBe("reconciling")
    await act(async () => Promise.resolve())
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("keeps a requestless conflict requestless when Overwrite preparation is not durable", async () => {
    const loadRemote = vi.fn().mockResolvedValue(snapshot({ ...first, title: "Remote" }, 8))
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Local" }, 9)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-160", initial: first, save, loadRemote }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const storage = throwJournalState("prepared")
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    expect(loadTodoJournal("JIN-160")?.request).toBeUndefined()
    storage.mockRestore()
    act(() => result.current.retry())
    expect(save).not.toHaveBeenCalled()
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
  })

  it("rehydrates requestless conflict provenance while Rebase A2 is ambiguous", async () => {
    const loadRemote = vi.fn().mockResolvedValue(snapshot({ ...first, title: "Remote", priority: 3 }, 8))
    const replay = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockRejectedValueOnce(new TypeError("response lost")).mockReturnValueOnce(replay.promise)
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-161", initial: first, save, loadRemote }))
    act(() => {
      mounted.result.current.change("title", "Local")
      mounted.result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(mounted.result.current.recoveredConflict).toBe(true))
    act(() => mounted.result.current.rebaseRemote(snapshot({ ...first, priority: 3 }, 8)))
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))
    expect(loadTodoJournal("JIN-161")?.conflictFields).toEqual(["title"])
    mounted.unmount()

    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-161",
      initial: { ...first, title: "Remote", priority: 3 },
      serverVersion: 8,
      save,
      loadRemote,
    }))
    expect(recovered.result.current.recoveredConflict).toBe(true)
    expect(recovered.result.current.conflictFields).toEqual(["title"])
    expect(recovered.result.current.conflictMode).toBe("reconciling")
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    replay.resolve(successful(snapshot({ ...first, title: "Local", priority: 3 }, 9), true))
  })

  it("keeps active cleanup and conflict provenance until removal succeeds", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "Local" }, 9)))
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-103", initial: first, serverVersion: 7, save }))
    act(() => {
      mounted.result.current.change("title", "Local")
      mounted.result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(mounted.result.current.recoveredConflict).toBe(true))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => mounted.result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))
    expect(mounted.result.current.isAcknowledged).toBe(false)
    expect(mounted.result.current.recoveredConflict).toBe(true)
    expect(loadTodoJournal("JIN-103")?.cleanupPending).toBe(true)
    mounted.unmount()
    remove.mockRestore()

    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-103",
      initial: { ...first, title: "Local" },
      serverVersion: 9,
      save,
      loadRemote: vi.fn().mockResolvedValue(snapshot({ ...first, title: "Local" }, 9)),
    }))
    expect(recovered.result.current.recoveredConflict).toBe(true)
    expect(recovered.result.current.isAcknowledged).toBe(false)
    act(() => recovered.result.current.retry())
    await waitFor(() => expect(recovered.result.current.isAcknowledged).toBe(true))
    expect(loadTodoJournal("JIN-103")).toBeNull()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("makes cleanup exclusive so Save retries removal without replaying acknowledged transport", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValueOnce(conflict)
      .mockResolvedValue(successful(snapshot({ ...first, title: "Local" }, 9)))
    const { result } = renderHook(() => useTodoDraft({
      id: "JIN-112",
      initial: first,
      serverVersion: 7,
      save,
    }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.cleanupPending).toBe(true)
    expect(result.current.error).not.toBeNull()

    act(() => result.current.save({ title: "Local" }))
    await act(async () => Promise.resolve())
    expect(save).toHaveBeenCalledTimes(2)
    expect(result.current.cleanupPending).toBe(true)

    remove.mockRestore()
    act(() => result.current.save({ title: "Local" }))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(result.current.cleanupPending).toBe(false)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("rebases a direct Save edit made during active cleanup onto the acknowledged snapshot", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const newest = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "Local" }, 9)))
      .mockReturnValueOnce(newest.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-111", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(result.current.cleanupPending).toBe(true))
    const obsoleteKey = (save.mock.calls[1]![0] as WorkItemEditRequest).idempotencyKey

    act(() => result.current.save({ title: "Newest" }))
    expect(result.current.draft.title).toBe("Newest")
    expect(result.current.isAcknowledged).toBe(false)
    expect(loadTodoJournal("JIN-111")?.patch.title).toBe("Newest")
    expect(save).toHaveBeenCalledTimes(3)

    remove.mockRestore()
    expect(save.mock.calls[2]![0]).toMatchObject({ patch: { title: "Newest" }, expectedVersion: 9 })
    expect((save.mock.calls[2]![0] as WorkItemEditRequest).idempotencyKey).not.toBe(obsoleteKey)
    expect(result.current.draft.title).toBe("Newest")
    expect(result.current.isAcknowledged).toBe(false)
    await act(async () => newest.resolve(successful(snapshot({ ...first, title: "Newest" }, 10))))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
  })

  it("rebases change then Save during active cleanup without replaying the obsolete request", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "Local" }, 9)))
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "Changed" }, 10)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-110", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(result.current.cleanupPending).toBe(true))

    act(() => {
      result.current.change("title", "Changed")
      result.current.save(result.current.unsavedPatch())
    })
    expect(result.current.draft.title).toBe("Changed")
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3))
    remove.mockRestore()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[2]![0]).toMatchObject({ patch: { title: "Changed" }, expectedVersion: 9 })
  })

  it("preserves and saves newer intent across requestless cleanup", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Newest" }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-117", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "Temporary"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => result.current.change("title", first.title))
    expect(result.current.cleanupPending).toBe(true)

    act(() => result.current.save({ title: "Newest" }))
    expect(result.current.draft.title).toBe("Newest")
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    remove.mockRestore()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[0]![0]).toMatchObject({ patch: { title: "Newest" }, expectedVersion: 7 })
  })

  it("keeps a cleanup-time change dirty and durable when Save was not requested", async () => {
    const save = vi.fn()
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-108", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "Temporary"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => result.current.change("title", first.title))
    act(() => result.current.change("title", "Newest"))
    remove.mockRestore()

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.cleanupPending).toBe(false))
    expect(result.current.draft.title).toBe("Newest")
    expect(result.current.status).toBe("dirty")
    expect(result.current.isAcknowledged).toBe(false)
    expect(loadTodoJournal("JIN-108")?.patch).toEqual({ title: "Newest" })
    expect(loadTodoJournal("JIN-108")?.request).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it("queues edit and Save while remounted cleanup GET is unresolved", async () => {
    persistTodoJournal("JIN-114", {
      revision: 1,
      patch: { title: "Recovered" },
      baseline: { title: first.title },
      baselineVersion: 7,
      cleanupPending: true,
    })
    const remote = deferred<TodoRemoteSnapshot>()
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Newest" }, 13)))
    const { result } = renderHook(() => useTodoDraft({
      id: "JIN-114",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote: vi.fn().mockReturnValue(remote.promise),
    }))
    act(() => result.current.retry())
    act(() => {
      result.current.change("title", "Newest")
      result.current.save({ title: "Newest" })
    })
    expect(result.current.draft.title).toBe("Newest")
    expect(result.current.cleanupPending).toBe(true)
    expect(result.current.isAcknowledged).toBe(false)
    expect(loadTodoJournal("JIN-114")?.patch.title).toBe("Newest")
    expect(save).not.toHaveBeenCalled()

    await act(async () => remote.resolve(snapshot(first, 12)))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ patch: { title: "Newest" }, expectedVersion: 12 })
    expect(result.current.draft.title).toBe("Newest")
  })

  it("rehydrates requestless cleanup intent and queued Save after repeated removal failures", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Newest" }, 13)))
    const mounted = renderHook(() => useTodoDraft({
      id: "JIN-118",
      initial: first,
      serverVersion: 7,
      save,
    }))
    act(() => mounted.result.current.change("title", "Temporary"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => mounted.result.current.change("title", first.title))
    const originalSet = Storage.prototype.setItem
    const replace = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "jinn:todo-draft-journal:v2" && !String(value).includes('"cleanupPending":true')) {
        throw new DOMException("blocked", "QuotaExceededError")
      }
      return originalSet.call(this, key, value)
    })
    act(() => mounted.result.current.save({ title: "Newest" }))
    act(() => mounted.result.current.retry())
    expect(loadTodoJournal("JIN-118")).toMatchObject({
      cleanupPending: true,
      cleanupIntentFields: ["title"],
      cleanupSaveRequested: true,
    })
    mounted.unmount()
    replace.mockRestore()
    remove.mockRestore()

    const loadRemote = vi.fn().mockResolvedValue(snapshot(first, 12))
    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-118",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote,
    }))
    expect(recovered.result.current.draft.title).toBe("Newest")
    act(() => recovered.result.current.retry())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ patch: { title: "Newest" }, expectedVersion: 12 })
  })

  it("rehydrates cleanup intent queued while a remote cleanup read was unresolved", async () => {
    persistTodoJournal("JIN-115", {
      revision: 1,
      patch: { title: "Recovered" },
      baseline: { title: first.title },
      baselineVersion: 7,
      cleanupPending: true,
    })
    const pendingRemote = deferred<TodoRemoteSnapshot>()
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Newest" }, 14)))
    const mounted = renderHook(() => useTodoDraft({
      id: "JIN-115",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote: vi.fn().mockReturnValue(pendingRemote.promise),
    }))
    act(() => mounted.result.current.retry())
    act(() => mounted.result.current.save({ title: "Newest" }))
    expect(loadTodoJournal("JIN-115")).toMatchObject({
      cleanupIntentFields: ["title"],
      cleanupSaveRequested: true,
    })
    mounted.unmount()
    await act(async () => pendingRemote.resolve(snapshot({ ...first, title: "Obsolete" }, 11)))

    const loadRemote = vi.fn().mockResolvedValue(snapshot(first, 13))
    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-115",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote,
    }))
    act(() => recovered.result.current.retry())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ patch: { title: "Newest" }, expectedVersion: 13 })
  })

  it("restores cleanup intent after switching A to B and back to A", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Newest A" }, 12)))
    const loadA = vi.fn().mockResolvedValue(snapshot(first, 11))
    const mounted = renderHook(
      ({ id, initial, version, loadRemote }: {
        id: string
        initial: TodoEditableDraft
        version: number
        loadRemote?: () => Promise<TodoRemoteSnapshot>
      }) => useTodoDraft({ id, initial, serverVersion: version, save, loadRemote }),
      {
        initialProps: {
          id: "JIN-120",
          initial: first,
          version: 7,
          loadRemote: undefined as (() => Promise<TodoRemoteSnapshot>) | undefined,
        },
      },
    )
    act(() => mounted.result.current.change("title", "Temporary A"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => mounted.result.current.change("title", first.title))
    const originalSet = Storage.prototype.setItem
    const replace = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "jinn:todo-draft-journal:v2" && !String(value).includes('"cleanupPending":true')) {
        throw new DOMException("blocked", "QuotaExceededError")
      }
      return originalSet.call(this, key, value)
    })
    act(() => mounted.result.current.save({ title: "Newest A" }))
    mounted.rerender({ id: "JIN-121", initial: { ...first, title: "Todo B" }, version: 4, loadRemote: undefined })
    await waitFor(() => expect(mounted.result.current.draft.title).toBe("Todo B"))
    replace.mockRestore()
    remove.mockRestore()
    mounted.rerender({ id: "JIN-120", initial: first, version: 7, loadRemote: loadA })
    await waitFor(() => expect(mounted.result.current.draft.title).toBe("Newest A"))

    act(() => mounted.result.current.retry())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ patch: { title: "Newest A" }, expectedVersion: 11 })
  })

  it("drops pre-cleanup fields but saves only cleanup-time fields after remount", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Remote", priority: 3 }, 13)))
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-113", initial: first, serverVersion: 7, save }))
    act(() => mounted.result.current.change("title", "Stale local title"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => mounted.result.current.reloadRemote(snapshot({ ...first, title: "Remote" }, 12)))
    const originalSet = Storage.prototype.setItem
    const replace = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "jinn:todo-draft-journal:v2" && !String(value).includes('"cleanupPending":true')) {
        throw new DOMException("blocked", "QuotaExceededError")
      }
      return originalSet.call(this, key, value)
    })
    act(() => mounted.result.current.save({ priority: 3 }))
    expect(loadTodoJournal("JIN-113")).toMatchObject({
      cleanupIntentFields: ["priority"],
      cleanupSaveRequested: true,
    })
    mounted.unmount()
    replace.mockRestore()
    remove.mockRestore()

    const remote = snapshot({ ...first, title: "Remote" }, 12)
    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-113",
      initial: remote.draft,
      serverVersion: remote.version,
      save,
      loadRemote: vi.fn().mockResolvedValue(remote),
    }))
    act(() => recovered.result.current.retry())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ patch: { priority: 3 }, expectedVersion: 12 })
    expect(save.mock.calls[0]![0].patch).not.toHaveProperty("title")
    expect(recovered.result.current.draft.title).toBe("Remote")
  })

  it("restores a cleanup-time change as requestless intent without dispatching", async () => {
    const save = vi.fn()
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-109", initial: first, serverVersion: 7, save }))
    act(() => mounted.result.current.change("title", "Stale local title"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => mounted.result.current.reloadRemote(snapshot({ ...first, title: "Remote" }, 12)))
    act(() => mounted.result.current.change("body", "Cleanup-time body"))
    expect(loadTodoJournal("JIN-109")).toMatchObject({ cleanupIntentFields: ["body"] })
    mounted.unmount()
    remove.mockRestore()

    const remote = snapshot({ ...first, title: "Remote" }, 12)
    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-109",
      initial: remote.draft,
      serverVersion: remote.version,
      save,
      loadRemote: vi.fn().mockResolvedValue(remote),
    }))
    act(() => recovered.result.current.retry())
    await waitFor(() => expect(recovered.result.current.cleanupPending).toBe(false))
    expect(recovered.result.current.draft).toMatchObject({ title: "Remote", body: "Cleanup-time body" })
    expect(loadTodoJournal("JIN-109")).toMatchObject({ patch: { body: "Cleanup-time body" } })
    expect(loadTodoJournal("JIN-109")?.request).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it.each(["throw", "silent"] as const)(
    "keeps cleanup intent durable when the atomic prepared replacement is a %s failure",
    async (failureMode) => {
      const id = testTodoId(`cleanup-atomic-${failureMode}`)
      const cleanup = {
        revision: 2,
        patch: { title: "Newest" },
        baseline: { title: first.title },
        baselineVersion: 7,
        cleanupPending: true as const,
        cleanupIntentFields: ["title"] as const,
        cleanupSaveRequested: true as const,
      }
      persistTodoJournal(id, cleanup as never)
      const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Newest" }, 9)))
      const mounted = renderHook(() => useTodoDraft({
        id,
        initial: first,
        serverVersion: 7,
        save,
        loadRemote: vi.fn().mockResolvedValue(snapshot(first, 8)),
      }))
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")
      const originalSet = Storage.prototype.setItem
      const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === "jinn:todo-draft-journal:v2" && !String(value).includes('"cleanupPending":true')) {
          if (failureMode === "throw") throw new DOMException("blocked", "QuotaExceededError")
          return
        }
        return originalSet.call(this, key, value)
      })

      act(() => mounted.result.current.retry())
      await waitFor(() => expect(mounted.result.current.cleanupPending).toBe(true))
      expect(save).not.toHaveBeenCalled()
      expect(loadTodoJournal(id)).toEqual(cleanup)
      expect(mounted.result.current.draft.title).toBe("Newest")
      expect(removeItem).not.toHaveBeenCalled()
      mounted.unmount()
      write.mockRestore()
      removeItem.mockRestore()

      const recovered = renderHook(() => useTodoDraft({
        id,
        initial: first,
        serverVersion: 7,
        save,
        loadRemote: vi.fn().mockResolvedValue(snapshot(first, 8)),
      }))
      act(() => recovered.result.current.retry())
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
      expect(save.mock.calls[0]![0]).toMatchObject({ patch: { title: "Newest" }, expectedVersion: 8 })
    },
  )

  it("rejects a cleanup snapshot below the strongest known version", async () => {
    persistTodoJournal("JIN-122", {
      revision: 2,
      patch: { title: "Newest" },
      baseline: { title: first.title },
      baselineVersion: 7,
      cleanupPending: true,
      cleanupIntentFields: ["title"],
      cleanupSaveRequested: true,
    })
    const save = vi.fn()
    const { result } = renderHook(() => useTodoDraft({
      id: "JIN-122",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote: vi.fn().mockResolvedValue(snapshot(first, 6)),
    }))

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.cleanupPending).toBe(true)
    expect(result.current.draft.title).toBe("Newest")
    expect(loadTodoJournal("JIN-122")?.cleanupPending).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it.each(["reloadRemote", "rebaseRemote", "overwriteRemote"] as const)(
    "rejects a stale authoritative snapshot in %s",
    (action) => {
      const save = vi.fn()
      const id = testTodoId(`floor-${action}`)
      const { result } = renderHook(() => useTodoDraft({ id, initial: first, serverVersion: 7, save }))
      act(() => result.current.change("title", "Local"))
      const before = loadTodoJournal(id)

      act(() => result.current[action](snapshot({ ...first, title: "Stale remote" }, 6)))

      expect(result.current.draft.title).toBe("Local")
      expect(loadTodoJournal(id)).toEqual(before)
      expect(save).not.toHaveBeenCalled()
    },
  )

  it("rejects a stale replaceInitial snapshot", () => {
    const save = vi.fn()
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-132", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "Local"))
    const before = loadTodoJournal("JIN-132")

    act(() => result.current.replaceInitial({ ...first, title: "Stale remote" }, 6))

    expect(result.current.draft.title).toBe("Local")
    expect(loadTodoJournal("JIN-132")).toEqual(before)
  })

  it("does not mint a stale acquired version after a stronger version arrives", async () => {
    const remote = deferred<TodoRemoteSnapshot>()
    const save = vi.fn()
    const mounted = renderHook(
      ({ version }: { version?: number }) => useTodoDraft({
        id: "JIN-102",
        initial: first,
        serverVersion: version,
        save,
        loadRemote: vi.fn().mockReturnValue(remote.promise),
      }),
      { initialProps: { version: undefined as number | undefined } },
    )
    act(() => {
      mounted.result.current.change("title", "Local")
      mounted.result.current.save({ title: "Local" })
    })
    mounted.rerender({ version: 7 })
    await act(async () => remote.resolve(snapshot(first, 6)))

    expect(save).not.toHaveBeenCalled()
    expect(mounted.result.current.draft.title).toBe("Local")
    expect(mounted.result.current.status).toBe("error")
  })

  it("refetches before Save when the cached baseline is below the observed version floor", async () => {
    const loadRemote = vi.fn().mockResolvedValue(snapshot(first, 9))
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Local" }, 10)))
    const mounted = renderHook(
      ({ version }: { version: number }) => useTodoDraft({
        id: "JIN-165",
        initial: first,
        serverVersion: version,
        save,
        loadRemote,
      }),
      { initialProps: { version: 7 } },
    )
    act(() => mounted.result.current.change("title", "Local"))
    mounted.rerender({ version: 9 })

    act(() => mounted.result.current.save({ title: "Local" }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))

    expect(loadRemote).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0]).toMatchObject({ patch: { title: "Local" }, expectedVersion: 9 })
  })

  it("does not mint when version-floor acquisition returns a lower snapshot", async () => {
    const loadRemote = vi.fn().mockResolvedValue(snapshot(first, 8))
    const save = vi.fn()
    const mounted = renderHook(
      ({ version }: { version: number }) => useTodoDraft({
        id: "JIN-164",
        initial: first,
        serverVersion: version,
        save,
        loadRemote,
      }),
      { initialProps: { version: 7 } },
    )
    act(() => mounted.result.current.change("title", "Local"))
    mounted.rerender({ version: 9 })

    act(() => mounted.result.current.save({ title: "Local" }))
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))

    expect(loadRemote).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
    expect(mounted.result.current.isAcknowledged).toBe(false)
  })

  it("stops safely when a stale cached baseline has no fresh loader", () => {
    const save = vi.fn()
    const mounted = renderHook(
      ({ version }: { version: number }) => useTodoDraft({
        id: "JIN-163",
        initial: first,
        serverVersion: version,
        save,
      }),
      { initialProps: { version: 7 } },
    )
    act(() => mounted.result.current.change("title", "Local"))
    mounted.rerender({ version: 9 })

    act(() => mounted.result.current.save({ title: "Local" }))

    expect(save).not.toHaveBeenCalled()
    expect(mounted.result.current.status).toBe("error")
    expect(mounted.result.current.isAcknowledged).toBe(false)
  })

  it("allows an equal cached baseline at the version floor", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Local" }, 10)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-162", initial: first, serverVersion: 9, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedVersion: 9 })
  })

  it("durably narrows a two-field conflict before publishing Rebase state", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValue(conflict)
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-149", initial: first, serverVersion: 7, save }))
    act(() => {
      mounted.result.current.change("title", "Local title")
      mounted.result.current.change("priority", 3)
      mounted.result.current.save(mounted.result.current.unsavedPatch())
    })
    await waitFor(() => expect(mounted.result.current.conflictFields).toEqual(["title", "priority"]))

    act(() => mounted.result.current.rebaseRemote(snapshot({ ...first, title: "Remote title" }, 8)))
    expect(mounted.result.current.conflictFields).toEqual(["title"])
    expect(loadTodoJournal("JIN-149")).toMatchObject({
      patch: { title: "Local title", priority: 3 },
      baseline: { title: first.title, priority: 0 },
      baselineVersion: 8,
      conflictFields: ["title"],
    })
    expect(loadTodoJournal("JIN-149")?.request).toBeUndefined()
    act(() => mounted.result.current.rebaseRemote(snapshot({ ...first, title: "Remote title" }, 8)))
    expect(mounted.result.current.conflictFields).toEqual(["title"])
    expect(save).toHaveBeenCalledTimes(1)
    mounted.unmount()

    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-149",
      initial: { ...first, title: "Remote title" },
      serverVersion: 8,
      save,
    }))
    expect(recovered.result.current.conflictFields).toEqual(["title"])
    expect(recovered.result.current.conflictMode).toBe("same-field")
    act(() => recovered.result.current.rebaseRemote(snapshot({ ...first, title: "Remote title" }, 8)))
    expect(recovered.result.current.conflictFields).toEqual(["title"])
    expect(save).toHaveBeenCalledTimes(1)

    act(() => recovered.result.current.overwriteRemote(snapshot({ ...first, title: "Remote title" }, 8)))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1]![0]).toMatchObject({
      patch: { title: "Local title", priority: 3 },
      expectedVersion: 8,
    })
  })

  it("does not publish a narrowed Rebase conflict when its journal replacement is silent", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValue(conflict)
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-148", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local title")
      result.current.change("priority", 3)
      result.current.save(result.current.unsavedPatch())
    })
    await waitFor(() => expect(result.current.conflictFields).toEqual(["title", "priority"]))
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => undefined)

    const candidate = snapshot({ ...first, title: "Remote title", body: "Remote body" }, 8)
    act(() => result.current.rebaseRemote(candidate))

    expect(result.current.conflictFields).toEqual(["title", "priority"])
    expect(result.current.conflictMode).toBe("unreconciled")
    expect(result.current.draft).toMatchObject({ title: "Local title", body: first.body, priority: 3 })
    expect(loadTodoJournal("JIN-148")?.conflictFields).toEqual(["title", "priority"])
    write.mockRestore()

    // Retrying the same candidate must still compare against the original
    // baseline. A memory-only baseline advance would incorrectly dispatch it.
    act(() => result.current.rebaseRemote(candidate))
    expect(result.current.conflictFields).toEqual(["title"])
    expect(loadTodoJournal("JIN-148")).toMatchObject({
      baselineVersion: 8,
      conflictFields: ["title"],
    })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["same field", { title: "B" }, { title: first.title }, { ...first, title: "C" }, ["title"]],
    ["mixed fields", { title: "B", priority: 3 }, { title: first.title, priority: 0 }, { ...first, title: "C" }, ["title"]],
  ] as const)("turns cleanup-time %s divergence into an explicit conflict", async (_label, patch, baseline, remoteDraft, fields) => {
    const id = testTodoId(`cleanup-conflict-${_label.replace(" ", "-")}`)
    persistTodoJournal(id, {
      revision: 2,
      patch: { ...patch },
      baseline: { ...baseline },
      baselineVersion: 8,
      cleanupPending: true,
      cleanupIntentFields: Object.keys(patch) as never,
      cleanupSaveRequested: true,
    })
    const save = vi.fn()
    const { result } = renderHook(() => useTodoDraft({
      id,
      initial: first,
      serverVersion: 8,
      save,
      loadRemote: vi.fn().mockResolvedValue(snapshot(remoteDraft, 9)),
    }))

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    expect(result.current.cleanupPending).toBe(false)
    expect(result.current.conflictFields).toEqual(fields)
    expect(save).not.toHaveBeenCalled()
    expect(loadTodoJournal(id)).toMatchObject({
      patch,
      baseline: Object.fromEntries(Object.keys(patch).map((field) => [
        field,
        fields.includes(field as never)
          ? baseline[field as keyof typeof baseline]
          : remoteDraft[field as keyof typeof remoteDraft],
      ])),
      baselineVersion: 9,
      conflictFields: fields,
    })
    expect(loadTodoJournal(id)?.request).toBeUndefined()
    act(() => result.current.rebaseRemote(snapshot(remoteDraft, 9)))
    expect(result.current.conflictFields).toEqual(fields)
    expect(save).not.toHaveBeenCalled()
  })

  it("keeps active cleanup blocked when journal removal silently does nothing", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "Local" }, 9)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-119", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => undefined)

    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(result.current.cleanupPending).toBe(true))
    expect(result.current.isAcknowledged).toBe(false)
    expect(result.current.error).not.toBeNull()
    expect(loadTodoJournal("JIN-119")?.cleanupPending).toBe(true)
  })

  it("retains a failed Reload snapshot version for same-mount cleanup Retry", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Next" }, 13)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-157", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "Temporary"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => result.current.reloadRemote(snapshot({ ...first, title: "Remote" }, 12)))
    expect(result.current.cleanupPending).toBe(true)
    remove.mockRestore()

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(result.current.draft.title).toBe("Remote")
    act(() => {
      result.current.change("title", "Next")
      result.current.save({ title: "Next" })
    })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedVersion: 12, patch: { title: "Next" } })
  })

  it("refetches and validates remote before clearing remounted cleanup", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Next" }, 14)))
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-156", initial: first, serverVersion: 7, save }))
    act(() => mounted.result.current.change("title", "Temporary"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => mounted.result.current.reloadRemote(snapshot({ ...first, title: "Lost volatile" }, 11)))
    mounted.unmount()
    remove.mockRestore()

    const loadRemote = vi.fn().mockResolvedValue(snapshot({ ...first, title: "Fresh" }, 13))
    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-156",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote,
    }))
    expect(recovered.result.current.cleanupPending).toBe(true)
    expect(recovered.result.current.error).not.toBeNull()
    expect(recovered.result.current.status).toBe("error")
    act(() => recovered.result.current.retry())
    await waitFor(() => expect(recovered.result.current.isAcknowledged).toBe(true))
    expect(loadRemote).toHaveBeenCalledTimes(1)
    expect(recovered.result.current.draft.title).toBe("Fresh")
    act(() => {
      recovered.result.current.change("title", "Next")
      recovered.result.current.save({ title: "Next" })
    })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedVersion: 13 })
  })

  it("keeps remounted cleanup blocked when the fresh remote snapshot is incomplete", async () => {
    persistTodoJournal("JIN-155", {
      revision: 1,
      patch: { title: "Recovered" },
      baseline: { title: first.title },
      baselineVersion: 7,
      cleanupPending: true,
    })
    const loadRemote = vi.fn().mockResolvedValue({ draft: { title: "Incomplete" }, version: 8 })
    const save = vi.fn()
    const { result } = renderHook(() => useTodoDraft({
      id: "JIN-155",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote: loadRemote as never,
    }))

    act(() => result.current.retry())
    await waitFor(() => expect(loadRemote).toHaveBeenCalledTimes(1))
    expect(result.current.cleanupPending).toBe(true)
    expect(result.current.error).not.toBeNull()
    expect(result.current.isAcknowledged).toBe(false)
    expect(loadTodoJournal("JIN-155")?.cleanupPending).toBe(true)
  })

  it.each([
    ["failed", new TodoApiError(403, "private", "WORK_ITEM_APPROVAL_PENDING")],
    ["conflict", new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)],
  ] as const)("atomically persists a %s terminal result after one silent write failure", async (state, failure) => {
    const save = vi.fn().mockRejectedValue(failure)
    const original = Storage.prototype.setItem
    let skipped = false
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (!skipped && key === "jinn:todo-draft-journal:v2" && String(value).includes(`\"state\":\"${state}\"`)) {
        skipped = true
        return
      }
      return original.call(this, key, value)
    })
    const id = testTodoId(`terminal-once-${state}`)
    const mounted = renderHook(() => useTodoDraft({ id, initial: first, serverVersion: 7, save }))
    act(() => {
      mounted.result.current.change("title", "Local")
      mounted.result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))
    expect(loadTodoJournal(id)?.request?.state).toBe(state)
    mounted.unmount()

    renderHook(() => useTodoDraft({ id, initial: first, serverVersion: 7, save }))
    await act(async () => Promise.resolve())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("omits resolved conflict provenance from atomic A2 to A3 replacement", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const a2 = deferred<ReturnType<typeof successful>>()
    const a3 = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockRejectedValueOnce(conflict).mockReturnValueOnce(a2.promise).mockReturnValue(a3.promise)
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-124", initial: first, serverVersion: 7, save }))
    act(() => {
      mounted.result.current.change("title", "Local")
      mounted.result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(mounted.result.current.recoveredConflict).toBe(true))
    act(() => mounted.result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    act(() => mounted.result.current.change("title", "Newest"))
    await act(async () => a2.resolve(successful(snapshot({ ...first, title: "Local" }, 9))))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3))
    expect(mounted.result.current.recoveredConflict).toBe(false)
    expect(loadTodoJournal("JIN-124")?.conflictFields).toBeUndefined()
    mounted.unmount()

    const recovered = renderHook(() => useTodoDraft({ id: "JIN-124", initial: { ...first, title: "Local" }, serverVersion: 9, save }))
    expect(recovered.result.current.recoveredConflict).toBe(false)
    expect(recovered.result.current.conflictFields).toEqual([])
    a3.resolve(successful(snapshot({ ...first, title: "Newest" }, 10), true))
  })

  it("keeps an exact terminal request safe when terminal persistence fails", async () => {
    const failure = new TodoApiError(403, "private", "WORK_ITEM_APPROVAL_PENDING")
    const save = vi.fn().mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "Local" }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-166", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "Local"))
    const storage = throwJournalState("failed")
    act(() => result.current.save({ title: "Local" }))
    await waitFor(() => expect(result.current.error).toBe(failure))
    const firstRequest = structuredClone(save.mock.calls[0]![0])
    expect(result.current.isAcknowledged).toBe(false)
    storage.mockRestore()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[1]![0]).toEqual(firstRequest)
  })

  it("keeps the old conflict blocked when conflict-to-A2 persistence fails", async () => {
    const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
    const save = vi.fn().mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "Local" }, 9)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-125", initial: first, serverVersion: 7, save }))
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
    expect(loadTodoJournal("JIN-125")?.request).toMatchObject(oldRequest)

    act(() => result.current.overwriteRemote(snapshot({ ...first, title: "Remote" }, 8)))
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("keeps close blocked through an edit made while A1 is saving and A2 is pending", async () => {
    const a1 = deferred<ReturnType<typeof successful>>()
    const a2 = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(a2.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-123", initial: first, serverVersion: 7, save }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-104", initial: first, serverVersion: 7, save }))
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
    expect(loadTodoJournal("JIN-104")?.request).toMatchObject({ patch: { title: "C" }, expectedVersion: 8 })
    setItem.mockRestore()
    removeItem.mockRestore()
    await act(async () => a2.resolve(successful(snapshot({ ...first, title: "C" }, 9))))
  })

  it("isolates an item switch from a late response without clearing the old journal", async () => {
    const pending = deferred<ReturnType<typeof successful>>()
    const save = vi.fn().mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(
      ({ id, title }) => useTodoDraft({ id, initial: { ...first, title }, serverVersion: 7, save }),
      { initialProps: { id: "JIN-139", title: first.title } },
    )
    act(() => {
      result.current.change("title", "First changed")
      result.current.save({ title: "First changed" })
    })
    rerender({ id: "JIN-167", title: "Second todo" })
    await act(async () => pending.resolve(successful(snapshot({ ...first, title: "First changed" }, 8))))
    expect(result.current.draft.title).toBe("Second todo")
    expect(loadTodoJournal("JIN-139")?.request).toBeDefined()
  })

  it("recovers only dirty fields over fresh data and preserves the storage cap", () => {
    const save = vi.fn()
    const firstMount = renderHook(() => useTodoDraft({ id: "JIN-145", initial: first, serverVersion: 7, save }))
    act(() => firstMount.result.current.change("title", "User-authored wi_text"))
    firstMount.unmount()
    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-145",
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
    expect(persisted).toContain("JIN-145")
  })

  it("uses the current server version for requestless recovered intent", async () => {
    persistTodoJournal("JIN-159", {
      revision: 1,
      patch: { title: "Local" },
      baseline: { title: first.title },
      baselineVersion: 7,
    })
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "Local", priority: 3 }, 9)))
    const { result } = renderHook(() => useTodoDraft({
      id: "JIN-159",
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
    const firstMount = renderHook(() => useTodoDraft({ id: "JIN-133", initial: first, save, loadRemote }))
    act(() => {
      firstMount.result.current.change("title", "Local")
      firstMount.result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(firstMount.result.current.recoveredConflict).toBe(true))
    firstMount.unmount()

    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-133",
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-101", initial: first, save, loadRemote }))
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-138", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Local")
      result.current.save({ title: "Local" })
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.isAcknowledged).toBe(false)
    expect(loadTodoJournal("JIN-138")?.request).toBeDefined()
  })

  it("rejects a regressive successful version and exact-replays without a CAS downgrade", async () => {
    const save = vi.fn()
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "B", priority: 3 }, 6)))
      .mockResolvedValueOnce(successful(snapshot({ ...first, title: "B" }, 8), true))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-153", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    const firstRequest = structuredClone(save.mock.calls[0]![0])
    expect(result.current.isAcknowledged).toBe(false)
    expect(result.current.draft.priority).toBe(0)
    expect(loadTodoJournal("JIN-153")?.request).toMatchObject({ expectedVersion: 7 })

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save.mock.calls[1]![0]).toEqual(firstRequest)
    expect(save.mock.calls[1]![0]).toMatchObject({ expectedVersion: 7 })
  })

  it("accepts a no-op successful response at the expected version", async () => {
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "B" }, 7)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-129", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "B")
      result.current.save({ title: "B" })
    })

    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(1)
    expect(loadTodoJournal("JIN-129")).toBeNull()
  })

  it("drops an undurable unsent candidate on revert without later replay", async () => {
    const save = vi.fn()
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-106", initial: first, serverVersion: 7, save }))
    act(() => mounted.result.current.change("title", "B"))
    const storage = throwJournalState("prepared")
    act(() => mounted.result.current.save({ title: "B" }))
    await waitFor(() => expect(mounted.result.current.status).toBe("error"))
    storage.mockRestore()
    act(() => mounted.result.current.change("title", first.title))
    expect(mounted.result.current.isAcknowledged).toBe(true)
    mounted.unmount()
    renderHook(() => useTodoDraft({ id: "JIN-106", initial: first, serverVersion: 7, save }))
    await act(async () => Promise.resolve())
    expect(save).not.toHaveBeenCalled()
  })

  it("replaces an undurable unsent candidate after edit with a new request", async () => {
    const keys = [
      "123e4567-e89b-42d3-a456-426614174000",
      "987e6543-e21b-42d3-a456-426614174999",
    ]
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => keys.shift() as `${string}-${string}-${string}-${string}-${string}`)
    const save = vi.fn().mockResolvedValue(successful(snapshot({ ...first, title: "C" }, 8)))
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-105", initial: first, serverVersion: 7, save }))
    act(() => result.current.change("title", "B"))
    const storage = throwJournalState("prepared")
    act(() => result.current.save({ title: "B" }))
    await waitFor(() => expect(result.current.status).toBe("error"))
    storage.mockRestore()
    act(() => {
      result.current.change("title", "C")
      result.current.save({ title: "C" })
    })
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0]).toEqual({
      patch: { title: "C" },
      expectedVersion: 7,
      idempotencyKey: "987e6543-e21b-42d3-a456-426614174999",
    })
  })

  it("keeps requestless cleanup blocked until removal is verified", async () => {
    const save = vi.fn()
    const mounted = renderHook(() => useTodoDraft({ id: "JIN-116", initial: first, serverVersion: 7, save }))
    act(() => mounted.result.current.change("title", "Temporary"))
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    act(() => mounted.result.current.change("title", first.title))
    expect(mounted.result.current.isAcknowledged).toBe(false)
    expect(loadTodoJournal("JIN-116")?.cleanupPending).toBe(true)
    mounted.unmount()
    remove.mockRestore()
    const recovered = renderHook(() => useTodoDraft({
      id: "JIN-116",
      initial: first,
      serverVersion: 7,
      save,
      loadRemote: vi.fn().mockResolvedValue(snapshot(first, 7)),
    }))
    expect(recovered.result.current.isAcknowledged).toBe(false)
    act(() => recovered.result.current.retry())
    await waitFor(() => expect(recovered.result.current.isAcknowledged).toBe(true))
    expect(loadTodoJournal("JIN-116")).toBeNull()
  })

  it.each(["reloadRemote", "rebaseRemote", "overwriteRemote"] as const)(
    "leaves state unchanged when %s receives a malformed snapshot",
    async (action) => {
      const conflict = new TodoApiError(409, "private", "TODO_VERSION_CONFLICT", 8)
      const save = vi.fn().mockRejectedValue(conflict)
      const id = testTodoId(`malformed-${action}`)
      const { result } = renderHook(() => useTodoDraft({ id, initial: first, serverVersion: 7, save }))
      act(() => {
        result.current.change("title", "Local")
        result.current.save({ title: "Local" })
      })
      await waitFor(() => expect(result.current.recoveredConflict).toBe(true))
      const beforeDraft = result.current.draft
      const beforeJournal = loadTodoJournal(id)
      act(() => result.current[action]({ draft: { title: "Incomplete" }, version: 8 } as never))
      expect(result.current.draft).toEqual(beforeDraft)
      expect(result.current.recoveredConflict).toBe(true)
      expect(result.current.conflictFields).toEqual(["title"])
      expect(loadTodoJournal(id)).toEqual(beforeJournal)
    },
  )

  it("acknowledges an exact clean revert without transport", () => {
    const save = vi.fn()
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-107", initial: first, serverVersion: 7, save }))
    act(() => {
      result.current.change("title", "Temporary")
      result.current.change("title", first.title)
    })
    expect(result.current.unsavedPatch()).toEqual({})
    expect(result.current.isAcknowledged).toBe(true)
    expect(result.current.status).toBe("idle")
    expect(loadTodoJournal("JIN-107")).toBeNull()
  })

  it("recovers an active request without replacing its sent fingerprint", async () => {
    persistTodoJournal("JIN-152", {
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
    const { result } = renderHook(() => useTodoDraft({ id: "JIN-152", initial: first, serverVersion: 7, save }))
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
