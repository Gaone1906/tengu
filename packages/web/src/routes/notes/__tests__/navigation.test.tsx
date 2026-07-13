import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NAV_ITEMS, MOBILE_TAB_ITEMS, OVERFLOW_HREFS } from "@/lib/nav"
import { queryKeys } from "@/lib/query-keys"
import { STATIC_PAGES } from "@/components/global-search"
import { useQueryInvalidation } from "@/hooks/use-query-invalidation"

let gatewayListener: ((event: string, payload: unknown) => void) | undefined

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    subscribe: (listener: (event: string, payload: unknown) => void) => {
      gatewayListener = listener
      return () => { gatewayListener = undefined }
    },
  }),
}))

describe("Notes navigation", () => {
  it("lazy-routes /notes", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8")
    expect(source).toContain("lazyRoute(() => import('./routes/notes/page'), 'notes')")
    expect(source).toContain("{ path: '/notes', element: <NotesPage /> }")
  })

  it("orders desktop and mobile destinations around Notes", () => {
    expect(NAV_ITEMS.slice(0, 4).map((item) => item.href)).toEqual([
      "/",
      "/todos",
      "/notes",
      "/workflow",
    ])
    expect(MOBILE_TAB_ITEMS.map((item) => item.href)).toEqual([
      "/",
      "/todos",
      "/notes",
      "/workflow",
      "/more",
    ])
    expect(OVERFLOW_HREFS).not.toContain("/notes")
  })

  it("exposes Notes as a global-search destination without a body query", () => {
    expect(STATIC_PAGES).toContainEqual(expect.objectContaining({
      id: "page-notes",
      label: "Notes",
      href: "/notes",
    }))
  })
})

describe("notes:changed invalidation", () => {
  beforeEach(() => { gatewayListener = undefined })

  it("invalidates the list and matching document query", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(client, "invalidateQueries")
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    renderHook(() => useQueryInvalidation(), { wrapper })

    act(() => gatewayListener?.("notes:changed", {
      path: "knowledge/product/principles.md",
      revision: "revision-2",
      action: "updated",
    }))

    await act(async () => {})
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.notes.all })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.notes.document("knowledge/product/principles.md"),
    })
  })
})
