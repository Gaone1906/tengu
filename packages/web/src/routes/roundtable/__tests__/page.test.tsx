import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { colorForName } from "@/lib/color-pool"

vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/hooks/use-session-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-session-telemetry")>()
  return {
    ...actual,
    useSessionTelemetry: () => ({
      data: {
        sessions: [],
        account: {},
        rootProgress: [],
        employeeProgress: [
          { assignee: "frontend", total: 4, completed: 3, inFlight: 1 },
        ],
        capturedAt: new Date().toISOString(),
      },
      phase: "ready" as const,
      now: Date.now(),
    }),
  }
})

const mocks = vi.hoisted(() => ({
  listWorkItems: vi.fn(),
  createSession: vi.fn(),
  getOrg: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listWorkItems: mocks.listWorkItems,
      createSession: mocks.createSession,
      getOrg: mocks.getOrg,
    },
  }
})

const employees = [
  { name: "frontend", displayName: "Frontend Generalist", department: "generalists", rank: "manager" as const, engine: "claude", model: "opus", persona: "" },
  { name: "backend", displayName: "Backend Generalist", department: "generalists", rank: "manager" as const, engine: "claude", model: "opus", persona: "" },
  { name: "testing", displayName: "Testing Generalist", department: "generalists", rank: "manager" as const, engine: "claude", model: "opus", persona: "" },
  { name: "acme-repo", displayName: "Acme Repo Specialist", department: "specialists", rank: "employee" as const, engine: "claude", model: "sonnet", persona: "", repo: "~/acme" },
]

const projectRoot = {
  id: "wi_project1", title: "Acme Redesign", status: "open" as const, assignee: null,
  department: null, source: "human" as const, sourceRef: null, approvalState: null,
  approvalRequest: null, approvalRef: null, approvalTarget: null, approvalEscalatedAt: null,
  depth: 0, rootId: "wi_project1", workspacePath: "~/acme", updatedAt: new Date().toISOString(),
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
}

beforeEach(() => {
  mocks.listWorkItems.mockReset().mockResolvedValue({ workItems: [projectRoot] })
  mocks.createSession.mockReset().mockResolvedValue({ id: "sess_new1" })
  mocks.getOrg.mockReset().mockResolvedValue({ departments: [], employees, hierarchy: {} })
})

import RoundtablePage from "../page"

describe("RoundtablePage", () => {
  it("seats the generalists around the table with distinct avatar colors", async () => {
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <RoundtablePage />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText("Acme Redesign")).toBeTruthy()
    for (const emp of employees.filter((e) => e.department === "generalists")) {
      expect(screen.getByTestId(`generalist-seat-${emp.name}`)).toBeTruthy()
    }

    // Each avatar's ring is the deterministic color-pool color for its own
    // name (EmployeeAvatar's fallback, since these fixtures carry no
    // settings.employeeOverrides) — distinct names read as distinct rings.
    const generalistNames = employees.filter((e) => e.department === "generalists").map((e) => e.name)
    const colorByName = new Map(
      generalistNames.map((name) => [
        name,
        (screen.getByTestId(`generalist-seat-${name}`).querySelector("span") as HTMLSpanElement).style.boxShadow,
      ]),
    )
    for (const name of generalistNames) {
      expect(colorByName.get(name)).toBe(`0 0 0 2px ${colorForName(name)}`)
    }
    // "frontend" and "backend" are known non-colliding buckets in the pool —
    // demonstrates the ring genuinely varies by employee, not a fixed color.
    expect(colorByName.get("frontend")).not.toBe(colorByName.get("backend"))

    // Specialists (a different department) are not seated at the council table.
    expect(screen.queryByTestId("generalist-seat-acme-repo")).toBeNull()
  })

  it("opens the per-generalist progress panel on click, with a bound chat box", async () => {
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <RoundtablePage />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const seat = await screen.findByTestId("generalist-seat-frontend")
    expect(screen.queryByTestId("generalist-panel-frontend")).toBeNull()

    fireEvent.click(seat)

    const panel = await screen.findByTestId("generalist-panel-frontend")
    expect(panel.textContent).toContain("3/4 done")
    expect(panel.textContent).toContain("1 in flight")
    expect(panel.textContent).toContain("75%")

    const input = screen.getByLabelText("Message Frontend Generalist")
    fireEvent.change(input, { target: { value: "kick off the plan" } })
    fireEvent.click(screen.getByLabelText("Send to Frontend Generalist"))

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
    const params = mocks.createSession.mock.calls[0][0]
    expect(params.employee).toBe("frontend")
    expect(params.prompt).toBe("kick off the plan")

    // Clicking the same seat again closes the panel.
    fireEvent.click(seat)
    await waitFor(() => expect(screen.queryByTestId("generalist-panel-frontend")).toBeNull())
  })
})
