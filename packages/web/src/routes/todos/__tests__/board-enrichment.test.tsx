import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useBoardTrees } from "../board/use-board"
import { useOpenDetails } from "../use-todos"

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("board enrichment network fan-out", () => {
  it("fetches trees and open details for 60 ids in exactly two requests", async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `PLA-${index + 1}`)
    const fetchSpy = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/api/work-items/trees") {
        return new Response(JSON.stringify({ trees: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.pathname === "/api/work-items") {
        return new Response(JSON.stringify({ workItems: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 })
    })
    vi.stubGlobal("fetch", fetchSpy)

    renderHook(() => {
      useBoardTrees(ids)
      useOpenDetails(ids)
    }, { wrapper })

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    const urls = fetchSpy.mock.calls.map(([input]) => new URL(String(input)))
    expect(urls.map((url) => url.pathname).sort()).toEqual([
      "/api/work-items",
      "/api/work-items/trees",
    ])
    for (const url of urls) {
      expect(url.searchParams.get("ids")?.split(",")).toEqual(ids)
    }
  })
})
