import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { useTodoPrefixes } from "../use-todo-prefixes"

const onboarding = {
  needed: false,
  onboarded: true,
  sessionsCount: 1,
  hasEmployees: true,
  companyName: "Example Company",
  companyPrefix: "EXA",
  todoPrefix: "EXA",
  todoPrefixFrozen: true,
  portalName: "Portal",
  operatorName: "Operator",
}

function testQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useTodoPrefixes", () => {
  it("keeps the set empty until both prefix queries resolve", async () => {
    const departments = deferred<Awaited<ReturnType<typeof api.getDepartments>>>()
    vi.spyOn(api, "getOnboarding").mockResolvedValue(onboarding)
    vi.spyOn(api, "getDepartments").mockReturnValue(departments.promise)
    const { client, wrapper } = testQueryClient()

    const { result } = renderHook(() => useTodoPrefixes(), { wrapper })

    await waitFor(() => expect(client.getQueryData(queryKeys.onboarding)).toEqual(onboarding))
    expect(result.current.size).toBe(0)
  })

  it("unions the company Todo prefix with every department prefix", async () => {
    vi.spyOn(api, "getOnboarding").mockResolvedValue(onboarding)
    vi.spyOn(api, "getDepartments").mockResolvedValue({
      departments: [
        { slug: "platform", prefix: "PLA", createdAt: "2026-01-01", todoCount: 3 },
        { slug: "operations", prefix: "OPS", createdAt: "2026-01-01", todoCount: 2 },
      ],
    })
    const { wrapper } = testQueryClient()

    const { result } = renderHook(() => useTodoPrefixes(), { wrapper })

    await waitFor(() => expect([...result.current]).toEqual(["EXA", "PLA", "OPS"]))
  })
})
