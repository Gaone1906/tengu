import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useTodoDraft } from "../use-todo-draft"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const first = {
  title: "First todo",
  body: "Original body",
  assignee: null,
  department: null,
  priority: 0,
}

describe("useTodoDraft", () => {
  beforeEach(() => sessionStorage.clear())

  it("recovers only locally dirty fields over fresh server data from another tab", () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const tabA = renderHook(() => useTodoDraft({
      id: "wi_private_multitab",
      initial: first,
      serverVersion: "version-a",
      save,
    }))
    act(() => tabA.result.current.change("title", "Tab A title"))
    tabA.unmount()

    const serverAfterTabB = { ...first, priority: 3 }
    const recovered = renderHook(() => useTodoDraft({
      id: "wi_private_multitab",
      initial: serverAfterTabB,
      serverVersion: "version-b",
      save,
    }))

    expect(recovered.result.current.draft).toEqual({ ...serverAfterTabB, title: "Tab A title" })
    expect(recovered.result.current.unsavedPatch()).toEqual({ title: "Tab A title" })
  })

  it("rebases a recovered patch when fresh detail arrives after the sheet mounts", () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const firstMount = renderHook(() => useTodoDraft({ id: "wi_private_late_detail", initial: first, serverVersion: "a", save }))
    act(() => firstMount.result.current.change("title", "Local title"))
    firstMount.unmount()

    const placeholder = { ...first, title: "", body: "", priority: 0 }
    const recovered = renderHook(() => useTodoDraft({ id: "wi_private_late_detail", initial: placeholder, serverVersion: undefined, save }))
    act(() => recovered.result.current.replaceInitial({ ...first, title: "Remote title", priority: 3 }, "b"))

    expect(recovered.result.current.draft).toMatchObject({ title: "Local title", body: "Original body", priority: 3 })
    expect(recovered.result.current.unsavedPatch()).toEqual({ title: "Local title" })
  })

  it("keeps the local edit dirty when the same field changed remotely", () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const tabA = renderHook(() => useTodoDraft({
      id: "wi_private_same_field",
      initial: first,
      serverVersion: "version-a",
      save,
    }))
    act(() => tabA.result.current.change("title", "Unsaved local title"))
    tabA.unmount()

    const recovered = renderHook(() => useTodoDraft({
      id: "wi_private_same_field",
      initial: { ...first, title: "Remote title" },
      serverVersion: "version-b",
      save,
    }))

    expect(recovered.result.current.draft.title).toBe("Unsaved local title")
    expect(recovered.result.current.hasUnsaved).toBe(true)
    expect(recovered.result.current.recoveredConflict).toBe(true)
  })

  it("stores no opaque work-item ids in session storage keys or values", () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useTodoDraft({ id: "wi_private_storage_42", initial: first, save }))
    act(() => result.current.change("body", "Reference wi_private_in_body"))

    const persisted = Array.from({ length: sessionStorage.length }, (_, index) => {
      const key = sessionStorage.key(index) ?? ""
      return `${key}\n${sessionStorage.getItem(key) ?? ""}`
    }).join("\n")
    expect(persisted).not.toMatch(/wi_[a-z0-9_-]+/i)
  })

  it("drops expired recovery journals", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-12T08:00:00.000Z"))
    const save = vi.fn().mockResolvedValue(undefined)
    const firstMount = renderHook(() => useTodoDraft({ id: "wi_private_expiry", initial: first, save }))
    act(() => firstMount.result.current.change("body", "Expired draft"))
    firstMount.unmount()

    vi.setSystemTime(new Date("2026-07-14T08:00:00.000Z"))
    const recovered = renderHook(() => useTodoDraft({ id: "wi_private_expiry", initial: first, save }))
    expect(recovered.result.current.draft).toEqual(first)
    expect(recovered.result.current.hasUnsaved).toBe(false)
    vi.useRealTimers()
  })

  it("acknowledges a revision that reverts exactly to the baseline", () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useTodoDraft({ id: "wi_private_revert", initial: first, save }))

    act(() => {
      result.current.change("title", "Temporary")
      result.current.change("title", first.title)
    })

    expect(result.current.unsavedPatch()).toEqual({})
    expect(result.current.hasUnsaved).toBe(false)
    expect(result.current.isAcknowledged).toBe(true)
    expect(result.current.status).toBe("idle")
    expect(Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i) ?? "")).join()).not.toContain("Temporary")
  })

  it("does not acknowledge a close-time edit until its own save settles", async () => {
    const firstSave = deferred<void>()
    const closeTimeSave = deferred<void>()
    const save = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(closeTimeSave.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "one", initial: first, save }))

    act(() => {
      result.current.change("title", "First edit")
      result.current.save({ title: "First edit" })
      result.current.change("title", "Edited after close")
      result.current.save(result.current.unsavedPatch())
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.isAcknowledged).toBe(false)

    await act(async () => firstSave.resolve())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save).toHaveBeenNthCalledWith(2, { title: "Edited after close" })
    expect(result.current.isAcknowledged).toBe(false)

    await act(async () => closeTimeSave.resolve())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(result.current.draft.title).toBe("Edited after close")
  })

  it("coalesces a failed first save with edits made while it was in flight", async () => {
    const firstSave = deferred<void>()
    const save = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useTodoDraft({ id: "one", initial: first, save }))

    act(() => {
      result.current.change("title", "First edit")
      result.current.save({ title: "First edit" })
      result.current.change("title", "Latest edit")
      result.current.save(result.current.unsavedPatch())
    })
    await act(async () => firstSave.reject(new Error("Offline")))
    await waitFor(() => expect(result.current.status).toBe("error"))

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(2, { title: "Latest edit" })
  })

  it("keeps a failed second save recoverable and retries the latest revision", async () => {
    const firstSave = deferred<void>()
    const secondSave = deferred<void>()
    const save = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise)
      .mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useTodoDraft({ id: "one", initial: first, save }))

    act(() => {
      result.current.change("title", "First edit")
      result.current.save({ title: "First edit" })
      result.current.change("body", "Second edit")
      result.current.save(result.current.unsavedPatch())
    })
    await act(async () => firstSave.resolve())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await act(async () => secondSave.reject(new Error("Still offline")))
    await waitFor(() => expect(result.current.status).toBe("error"))

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.isAcknowledged).toBe(true))
    expect(save).toHaveBeenNthCalledWith(3, { body: "Second edit" })
  })

  it("recovers an item-scoped draft after unmount and clears it only after acknowledgement", async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const firstMount = renderHook(() => useTodoDraft({ id: "one", initial: first, save }))
    act(() => firstMount.result.current.change("body", "Recovered after reload"))
    firstMount.unmount()

    const secondMount = renderHook(() => useTodoDraft({ id: "one", initial: first, save }))
    expect(secondMount.result.current.draft.body).toBe("Recovered after reload")
    expect(secondMount.result.current.hasUnsaved).toBe(true)

    act(() => secondMount.result.current.save(secondMount.result.current.unsavedPatch()))
    await waitFor(() => expect(secondMount.result.current.isAcknowledged).toBe(true))
    secondMount.unmount()

    const thirdMount = renderHook(() => useTodoDraft({ id: "one", initial: first, save }))
    expect(thirdMount.result.current.draft).toEqual(first)
    expect(thirdMount.result.current.hasUnsaved).toBe(false)
  })

  it("serializes writes and never lets an older response overwrite a newer draft", async () => {
    const one = deferred<void>()
    const two = deferred<void>()
    const save = vi.fn()
      .mockReturnValueOnce(one.promise)
      .mockReturnValueOnce(two.promise)
    const { result } = renderHook(() => useTodoDraft({ id: "one", initial: first, save }))

    act(() => {
      result.current.change("title", "Renamed")
      result.current.save({ title: "Renamed" })
      result.current.change("priority", 3)
      result.current.save({ priority: 3 })
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe("saving")
    expect(result.current.draft).toMatchObject({ title: "Renamed", priority: 3 })

    await act(async () => one.resolve())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1]?.[0]).toEqual({ priority: 3 })
    await act(async () => two.resolve())
    await waitFor(() => expect(result.current.status).toBe("saved"))
    expect(result.current.draft).toMatchObject({ title: "Renamed", priority: 3 })
  })

  it("preserves a failed draft and retries the exact pending patch", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useTodoDraft({ id: "one", initial: first, save }))

    act(() => {
      result.current.change("body", "Unsaved but durable")
      result.current.save({ body: "Unsaved but durable" })
    })
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.draft.body).toBe("Unsaved but durable")
    expect(result.current.error).toBe("Network unavailable")

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe("saved"))
    expect(save).toHaveBeenNthCalledWith(2, { body: "Unsaved but durable" })
  })

  it("isolates drafts when switching items while an earlier write is pending", async () => {
    const pending = deferred<void>()
    const save = vi.fn().mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(
      ({ id, title }) => useTodoDraft({ id, initial: { ...first, title }, save }),
      { initialProps: { id: "one", title: "First todo" } },
    )

    act(() => {
      result.current.change("title", "First changed")
      result.current.save({ title: "First changed" })
    })
    rerender({ id: "two", title: "Second todo" })
    expect(result.current.draft.title).toBe("Second todo")

    await act(async () => pending.resolve())
    expect(result.current.draft.title).toBe("Second todo")
  })
})
