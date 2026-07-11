import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
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
