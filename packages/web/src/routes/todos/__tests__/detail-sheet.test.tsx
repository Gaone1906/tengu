import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemStatusWire } from "@/lib/api"
import { DetailSheet } from "../detail-sheet"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

function workItem(status: WorkItemStatusWire): WorkItemFullWire {
  return {
    id: `wi_${status}`,
    title: `Todo ${status}`,
    body: null,
    status,
    department: null,
    assignee: null,
    priority: 0,
    source: "human",
    sourceRef: null,
    acceptance: null,
    verifyPolicy: null,
    rounds: 0,
    budgetUsd: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    approvalDecidedBy: null,
    approvalDecidedAt: null,
    createdAt: "2026-07-11T08:00:00.000Z",
    updatedAt: "2026-07-11T08:00:00.000Z",
    closedAt: status === "done" || status === "cancelled" ? "2026-07-11T09:00:00.000Z" : null,
  }
}

function detail(status: WorkItemStatusWire): WorkItemDetailWire {
  return { workItem: workItem(status), spendUsd: 0, workflowRun: null, events: [] }
}

function renderSheet(status: WorkItemStatusWire) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DetailSheet
          id={`wi_${status}`}
          initial={detail(status)}
          byName={new Map()}
          resolving={false}
          onApprove={() => {}}
          onSendBack={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("Todo detail transition footer", () => {
  beforeEach(() => {
    authFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/sessions")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
      const status = JSON.parse(String(init?.body)).status as WorkItemStatusWire
      return new Response(JSON.stringify({ workItem: workItem(status), escalated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
  })

  it.each(["backlog", "assigned"] as const)("renders Start for %s and round-trips executing via PUT", async (status) => {
    renderSheet(status)

    fireEvent.click(screen.getByRole("button", { name: "Start" }))

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
      `/api/work-items/wi_${status}/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "executing" }),
      },
    ))
  })

  it.each(["executing", "blocked", "in_review", "escalated", "done", "cancelled"] as const)(
    "does not render Start for %s",
    (status) => {
      renderSheet(status)
      expect(screen.queryByRole("button", { name: "Start" })).toBeNull()
    },
  )
})
