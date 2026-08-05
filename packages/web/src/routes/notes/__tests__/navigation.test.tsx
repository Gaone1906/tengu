import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NAV_ITEMS, MOBILE_TAB_ITEMS, OVERFLOW_HREFS, navigationFor } from "@/lib/nav"
import { queryKeys } from "@/lib/query-keys"
import { STATIC_PAGES, staticPagesFor } from "@/components/global-search"
import { useQueryInvalidation } from "@/hooks/use-query-invalidation"
import type { GatewayEvent, GatewayEventListener } from "@jinn/gateway-events"

let gatewayListener: ((event: string, payload: unknown) => void) | undefined

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    subscribe: (listener: (event: string, payload: unknown) => void) => {
      const typedListener = listener as unknown as GatewayEventListener
      gatewayListener = (event, payload) => typedListener({ event, payload } as GatewayEvent)
      return () => { gatewayListener = undefined }
    },
  }),
}))

describe("Notes navigation", () => {
  it("feature-gates /notes before lazy-rendering it", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8")
    expect(source).toContain("lazyRoute(() => import('./routes/notes/page'), 'notes')")
    expect(source).toContain("{ path: '/notes', element: <NotesFeatureRoute /> }")
  })

  it("hides Notes by default and restores it only when enabled", () => {
    expect(NAV_ITEMS.map((item) => item.href)).not.toContain("/notes")
    expect(MOBILE_TAB_ITEMS.map((item) => item.href)).not.toContain("/notes")
    expect(navigationFor(true).items.map((item) => item.href)).toContain("/notes")
    expect(OVERFLOW_HREFS).not.toContain("/notes")
  })

  it("hides Notes from global search by default and restores it when enabled", () => {
    expect(STATIC_PAGES.map((page) => page.href)).not.toContain("/notes")
    expect(staticPagesFor(true)).toContainEqual(expect.objectContaining({
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
