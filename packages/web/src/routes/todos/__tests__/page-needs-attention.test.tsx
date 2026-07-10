import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OrgData, WorkItemCompactWire } from "@/lib/api"
import TodosPage from "../page"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { employeeOverrides: {} } }),
}))

const listWorkItems = vi.fn()
const searchWorkItems = vi.fn()
const getWorkItem = vi.fn()
const getOrg = vi.fn()
const decideWorkItemApproval = vi.fn()
const escalateWorkItemApproval = vi.fn()
const updateWorkItem = vi.fn()
const setWorkItemStatus = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    listWorkItems: (...a: unknown[]) => listWorkItems(...a),
    searchWorkItems: (...a: unknown[]) => searchWorkItems(...a),
    getWorkItem: (...a: unknown[]) => getWorkItem(...a),
    getOrg: (...a: unknown[]) => getOrg(...a),
    decideWorkItemApproval: (...a: unknown[]) => decideWorkItemApproval(...a),
    escalateWorkItemApproval: (...a: unknown[]) => escalateWorkItemApproval(...a),
    updateWorkItem: (...a: unknown[]) => updateWorkItem(...a),
    setWorkItemStatus: (...a: unknown[]) => setWorkItemStatus(...a),
  },
}))

function compact(overrides: Partial<WorkItemCompactWire> = {}): WorkItemCompactWire {
  return {
    id: "wi_default",
    title: "Default item",
    status: "in_review",
    assignee: "worker",
    department: "platform",
    source: "workflow",
    sourceRef: "workflow:daily:run-1",
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    updatedAt: "2026-07-06T12:00:00.000Z",
    ...overrides,
  }
}

const org: OrgData = {
  departments: ["platform"],
  employees: [],
  hierarchy: { root: "coo", sorted: ["coo"], warnings: [] },
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TodosPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("TodosPage Needs You inbox", () => {
  beforeEach(() => {
    listWorkItems.mockReset()
    getWorkItem.mockReset()
    getOrg.mockReset().mockResolvedValue(org)
    decideWorkItemApproval.mockReset().mockResolvedValue({ workItem: {}, escalated: false, mirrored: false })
    escalateWorkItemApproval.mockReset().mockResolvedValue({ workItem: {} })
    listWorkItems.mockImplementation((params?: { needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) {
        return Promise.resolve({
          workItems: [
            compact({ id: "wi_blocked", title: "Blocked latest", status: "blocked", updatedAt: "2026-07-06T12:10:00.000Z" }),
            compact({ id: "wi_approve", title: "Approve middle", approvalState: "pending", approvalRequest: "Approve the plan?", approvalTarget: "coo", updatedAt: "2026-07-06T12:05:00.000Z" }),
            compact({ id: "wi_sendback", title: "Send back older", approvalState: "pending", approvalRequest: "Review the draft", approvalTarget: "coo", updatedAt: "2026-07-06T12:04:00.000Z" }),
            compact({ id: "wi_escalate", title: "Escalate oldest", approvalState: "pending", approvalRequest: "Public action", approvalTarget: "coo", updatedAt: "2026-07-06T12:03:00.000Z" }),
          ],
        })
      }
      return Promise.resolve({ workItems: [] })
    })
  })

  it("loads Needs You from the server-derived attention endpoint without detail fanout", async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId("todos-tab-needs"))

    await waitFor(() => expect(screen.getByText("Approve the plan?")).toBeTruthy())

    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ needsAttentionFor: "me", limit: 20 }))
    expect(getWorkItem).not.toHaveBeenCalled()
    expect(screen.getAllByTestId(/needs-item-/).map((el) => el.getAttribute("data-testid"))).toEqual([
      "needs-item-wi_blocked",
      "needs-item-wi_approve",
      "needs-item-wi_sendback",
      "needs-item-wi_escalate",
    ])
  })

  it("wires approve, send-back, and escalation actions to the approval routes", async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId("todos-tab-needs"))

    fireEvent.click(await screen.findByTestId("approve-wi_approve"))
    await waitFor(() => expect(decideWorkItemApproval).toHaveBeenCalledWith("wi_approve", "approve", undefined))

    fireEvent.click(await screen.findByTestId("sendback-wi_sendback"))
    fireEvent.change(screen.getByTestId("sendback-note-wi_sendback"), { target: { value: "needs evidence" } })
    fireEvent.click(screen.getByTestId("sendback-confirm-wi_sendback"))
    await waitFor(() => expect(decideWorkItemApproval).toHaveBeenCalledWith("wi_sendback", "reject", "needs evidence"))

    fireEvent.click(screen.getByTestId("escalate-wi_escalate"))
    await waitFor(() => expect(escalateWorkItemApproval).toHaveBeenCalledWith("wi_escalate"))
  })
})
