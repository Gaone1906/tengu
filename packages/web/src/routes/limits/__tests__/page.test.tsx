/**
 * Limits page — client render is sanitary.
 *
 * Even if a snapshot arrives carrying a raw parser diagnostic or sensitive
 * payload fragment in its `error` field, the page must render only fixed,
 * operator-safe copy: no marker, parser position, or exception text in the
 * DOM text OR in any ARIA / title attribute.
 */
import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import type { EngineLimitsResponse } from "@/lib/api"

vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

let state: {
  data: EngineLimitsResponse | null
  phase: "loading" | "ready"
  refreshing: boolean
  error: string | null
  now: number
  refresh: () => void
}
vi.mock("../use-engine-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../use-engine-limits")>()
  return { ...actual, useEngineLimits: () => state }
})

import LimitsPage from "../page"

const MARKER = "SENSITIVE-SNAPSHOT-MARKER-a1b2c3"
const DIAGNOSTICS = ["position", "Unexpected", "Expected", "in JSON", "SyntaxError", MARKER]

describe("LimitsPage — no raw diagnostics in DOM/ARIA", () => {
  it("renders fixed copy even when snapshot.error carries raw parser/payload text", () => {
    const now = Date.now()
    state = {
      phase: "ready",
      refreshing: false,
      error: null,
      now,
      refresh: () => {},
      data: {
        generatedAt: new Date(now).toISOString(),
        default: "claude",
        engines: {
          // preserved-degraded: has windows + a raw error string
          claude: {
            name: "claude", available: true, status: "snapshot", source: "x",
            refreshedAt: new Date(now - 60_000).toISOString(), models: [],
            windows: [{ name: "5h", usedPercent: 42 }],
            error: `${MARKER} Unexpected token at position 2 in JSON`,
          },
          // hard error: no windows, raw error string
          codex: {
            name: "codex", available: true, status: "error", source: "x",
            refreshedAt: new Date(now).toISOString(), models: [],
            error: `${MARKER} SyntaxError: Unexpected end of JSON input at position 7`,
          },
        },
      },
    }

    const { container } = render(<LimitsPage />)
    const html = container.innerHTML // includes text AND aria-label/title attributes
    for (const diag of DIAGNOSTICS) {
      expect(html).not.toContain(diag)
    }
    // Sanity: the fixed last-known annotation is actually shown.
    expect(container.textContent).toMatch(/last-known/i)
  })
})
