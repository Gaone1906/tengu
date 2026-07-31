import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSetWorkItemStatus } from "../use-todos"
import { mergeTodoIntoCaches } from "../todo-edit-request"

const setWorkItemStatus = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
    },
  }
})

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(["work-items", "board", "platform", "executing"], {
    pages: [{ workItems: [{ id: "PLA-3", version: 4, status: "executing" }], total: 1, nextOffset: null }],
    pageParams: [0],
  })
  client.setQueryData(["work-item", "PLA-3"], {
    workItem: { id: "PLA-3", version: 4, status: "executing" },
    spendUsd: 0,
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => useSetWorkItemStatus(), { wrapper })
  return { client, mutation: hook.result }
}

function boardStatus(client: QueryClient): string | undefined {
  const board = client.getQueryData<{
    pages: Array<{ workItems: Array<{ id: string; status: string }> }>
  }>(["work-items", "board", "platform", "executing"])
  return board?.pages[0]?.workItems[0]?.status
}

function detailStatus(client: QueryClient): string | undefined {
  return client.getQueryData<{ workItem: { status: string } }>(["work-item", "PLA-3"])?.workItem.status
}

function detailVersion(client: QueryClient): number | undefined {
  return client.getQueryData<{ workItem: { version: number } }>(["work-item", "PLA-3"])?.workItem.version
}

describe("Todo status mutation caches", () => {
  beforeEach(() => vi.clearAllMocks())

  it("updates board and detail caches immediately, then restores both on rejection", async () => {
    let rejectRequest!: (error: Error) => void
    setWorkItemStatus.mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject }))
    const { client, mutation } = setup()

    act(() => mutation.current.mutate({ id: "PLA-3", status: "in_review" }))

    await waitFor(() => {
      expect(boardStatus(client)).toBe("in_review")
      expect(detailStatus(client)).toBe("in_review")
    })

    act(() => rejectRequest(new Error("refused")))
    await waitFor(() => {
      expect(boardStatus(client)).toBe("executing")
      expect(detailStatus(client)).toBe("executing")
    })
  })

  it("does not roll a newer live payload back after the request rejects", async () => {
    let rejectRequest!: (error: Error) => void
    setWorkItemStatus.mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject }))
    const { client, mutation } = setup()

    act(() => mutation.current.mutate({ id: "PLA-3", status: "in_review" }))
    await waitFor(() => expect(detailStatus(client)).toBe("in_review"))

    act(() => mergeTodoIntoCaches(client, { id: "PLA-3", version: 5, status: "done" }))
    expect(boardStatus(client)).toBe("done")
    expect(detailStatus(client)).toBe("done")

    act(() => rejectRequest(new Error("refused")))
    await waitFor(() => {
      expect(mutation.current.isError).toBe(true)
      expect(boardStatus(client)).toBe("done")
      expect(detailStatus(client)).toBe("done")
      expect(detailVersion(client)).toBe(5)
    })
  })
})
