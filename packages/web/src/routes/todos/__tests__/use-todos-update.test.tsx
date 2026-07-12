import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getWorkItem = vi.fn()
const updateWorkItem = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...original,
    api: {
      ...original.api,
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
    },
  }
})

const { useUpdateWorkItem } = await import("../use-todos")

describe("useUpdateWorkItem", () => {
  beforeEach(() => {
    getWorkItem.mockReset()
    updateWorkItem.mockReset()
  })

  it("wraps compact-row edits in a versioned, idempotent CAS request", async () => {
    getWorkItem.mockResolvedValue({ workItem: { id: "JIN-9", version: 7 } })
    updateWorkItem.mockResolvedValue({
      workItem: { id: "JIN-9", version: 8, title: "Renamed" },
      replayed: false,
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useUpdateWorkItem(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ id: "JIN-9", patch: { title: "Renamed" } })
    })

    expect(getWorkItem).toHaveBeenCalledWith("JIN-9")
    expect(updateWorkItem).toHaveBeenCalledWith("JIN-9", {
      patch: { title: "Renamed" },
      expectedVersion: 7,
      idempotencyKey: expect.any(String),
    })
  })
})
