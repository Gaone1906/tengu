import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
    id: "wi_private_default",
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

function renderPage(initialEntry = "/todos") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <TodosPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("TodosPage Needs You inbox", () => {
  beforeEach(() => {
    listWorkItems.mockReset()
    searchWorkItems.mockReset()
    getWorkItem.mockReset()
    getOrg.mockReset().mockResolvedValue(org)
    decideWorkItemApproval.mockReset().mockResolvedValue({ workItem: {}, escalated: false })
    escalateWorkItemApproval.mockReset().mockResolvedValue({ workItem: {} })
    listWorkItems.mockImplementation((params?: { needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) {
        return Promise.resolve({
          workItems: [
            compact({ id: "wi_private_blocked", title: "Blocked latest", status: "blocked", updatedAt: "2026-07-06T12:10:00.000Z" }),
            compact({ id: "wi_private_approve", title: "Approve middle", approvalState: "pending", approvalRequest: "Approve the plan?", approvalTarget: "coo", updatedAt: "2026-07-06T12:05:00.000Z" }),
            compact({ id: "wi_private_sendback", title: "Send back older", approvalState: "pending", approvalRequest: "Review the draft", approvalTarget: "coo", updatedAt: "2026-07-06T12:04:00.000Z" }),
            compact({ id: "wi_private_escalate", title: "Escalate oldest", approvalState: "pending", approvalRequest: "Public action", approvalTarget: "coo", updatedAt: "2026-07-06T12:03:00.000Z" }),
          ],
        })
      }
      return Promise.resolve({ workItems: [] })
    })
  })

  it("loads Needs You from the server-derived attention endpoint without detail fanout", async () => {
    renderPage()
    expect(await screen.findByTestId("needs-preview")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "View all" }))

    await waitFor(() => expect(screen.getByText("Approve the plan?")).toBeTruthy())

    expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ needsAttentionFor: "me", limit: 100 }))
    expect(getWorkItem).not.toHaveBeenCalled()
    expect(screen.getAllByTestId("needs-item").map((el) => el.querySelector("button")?.textContent)).toEqual([
      expect.stringContaining("Blocked latest"),
      expect.stringContaining("Approve middle"),
      expect.stringContaining("Send back older"),
      expect.stringContaining("Escalate oldest"),
    ])
  })

  it("wires approve, send-back, and escalation actions to the approval routes", async () => {
    renderPage()
    expect(await screen.findByTestId("needs-preview")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "View all" }))

    const approveCard = (await screen.findByText("Approve middle")).closest<HTMLElement>('[data-testid="needs-item"]')!
    fireEvent.click(within(approveCard).getByTestId("needs-approve"))
    await waitFor(() => expect(decideWorkItemApproval).toHaveBeenCalledWith("wi_private_approve", "approve", undefined))

    const sendBackCard = screen.getByText("Send back older").closest<HTMLElement>('[data-testid="needs-item"]')!
    fireEvent.click(within(sendBackCard).getByTestId("needs-sendback"))
    fireEvent.change(within(sendBackCard).getByTestId("needs-sendback-note"), { target: { value: "needs evidence" } })
    fireEvent.click(within(sendBackCard).getByTestId("needs-sendback-confirm"))
    await waitFor(() => expect(decideWorkItemApproval).toHaveBeenCalledWith("wi_private_sendback", "reject", "needs evidence"))

    const escalateCard = screen.getByText("Escalate oldest").closest<HTMLElement>('[data-testid="needs-item"]')!
    fireEvent.click(within(escalateCard).getByTestId("needs-escalate"))
    await waitFor(() => expect(escalateWorkItemApproval).toHaveBeenCalledWith("wi_private_escalate"))
  })
})

describe("TodosPage filtered totals", () => {
  beforeEach(() => {
    listWorkItems.mockReset().mockImplementation((params?: { status?: string; department?: string; needsAttentionFor?: string }) => {
      if (params?.needsAttentionFor) return Promise.resolve({ workItems: [], total: 0, nextOffset: null })
      const total = params?.status === "backlog"
        ? (params.department === "platform" ? 3 : 8)
        : params?.status === "done"
          ? (params.department === "platform" ? 2 : 5)
          : 0
      return Promise.resolve({ workItems: [], total, nextOffset: null })
    })
    searchWorkItems.mockReset()
    getOrg.mockReset().mockResolvedValue(org)
    getWorkItem.mockReset()
  })

  it("states an honest filtered subset of the primary open ledger", async () => {
    renderPage("/todos?department=platform")
    expect(await screen.findByText("3 of 8 open")).toBeTruthy()
  })

  it("uses the same open-status universe for search results and the denominator", async () => {
    searchWorkItems.mockImplementation((params?: { status?: string }) => Promise.resolve({
      workItems: [],
      total: params?.status === "backlog" ? 2 : params?.status === "done" ? 4 : 0,
      nextOffset: null,
    }))
    renderPage("/todos?q=roadmap")
    expect(await screen.findByText("2 of 8 open")).toBeTruthy()
  })
})
