import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { WorkItemCompactWire, WorkItemStatusWire, ApprovalStateWire } from "@/lib/api"
import { NeedsYouView } from "../needs-you-view"

/* Todos v2 slice 6 stage C — the Attention inbox restyled to states.html §1:
 * fixed kicker order (Approvals · Escalated · Blocked), oldest-first within a
 * group, mono ID line, the voice's rail quote (reason notes from detail
 * enrichment), and per-kind actions — approvals decide in place, escalated/
 * blocked route through legalTargets() menus. */

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { employeeOverrides: {} } }),
}))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getWorkItem: (...a: unknown[]) => getWorkItem(...a),
      getWorkItemTree: (...a: unknown[]) => getWorkItemTree(...a),
      setWorkItemStatus: (...a: unknown[]) => setWorkItemStatus(...a),
    },
  }
})

function item(
  id: string,
  status: WorkItemStatusWire,
  approvalState: ApprovalStateWire | null,
  over: Partial<WorkItemCompactWire> = {},
): WorkItemCompactWire {
  return {
    id,
    title: "Review this Todo",
    status,
    department: null,
    assignee: null,
    source: "cron",
    sourceRef: "cron:job:2026",
    approvalState,
    approvalRequest: approvalState === "pending" ? "Approve posting this?" : null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    updatedAt: "2026-07-05T11:00:00.000Z",
    ...over,
  }
}

function renderView(items: WorkItemCompactWire[], resolvingIds = new Set<string>()) {
  const onApprove = vi.fn<(id: string) => void>()
  const onReject = vi.fn<(id: string, note: string) => void>()
  const onOpen = vi.fn<(id: string) => void>()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NeedsYouView items={items} byName={new Map()} resolvingIds={resolvingIds} onApprove={onApprove} onReject={onReject} onOpen={onOpen} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onApprove, onReject, onOpen, container: view.container }
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItem.mockRejectedValue(Object.assign(new Error("nf"), { status: 404 }))
  getWorkItemTree.mockRejectedValue(Object.assign(new Error("nf"), { status: 404 }))
})

describe("NeedsYouView", () => {
  it("shows the All quiet. zero state when nothing needs the caller (states mock §6)", () => {
    renderView([])
    expect(screen.getByTestId("needs-you-empty")).toBeTruthy()
    expect(screen.getByText("All quiet.")).toBeTruthy()
  })

  it("groups by kind in fixed kicker order — Approvals, Escalated, Blocked — oldest first within a group", () => {
    renderView([
      item("wi_private_blocked", "blocked", null, { title: "Blocked item" }),
      item("wi_private_ap_new", "in_review", "pending", { title: "Newer approval", updatedAt: "2026-07-05T11:00:00.000Z" }),
      item("wi_private_ap_old", "in_review", "pending", { title: "Older approval", updatedAt: "2026-07-01T09:00:00.000Z" }),
      item("wi_private_escalated", "escalated", null, { title: "Escalated item" }),
    ])
    const groups = screen.getAllByTestId(/needs-group-/).map((el) => el.getAttribute("data-testid"))
    expect(groups).toEqual(["needs-group-approval", "needs-group-escalated", "needs-group-blocked"])
    // Oldest-first inside Approvals: the longest-waiting ask wins.
    const titles = screen.getAllByTestId("needs-item").map((el) => el.textContent ?? "")
    expect(titles[0]).toContain("Older approval")
    expect(titles[1]).toContain("Newer approval")
    // True counts on the kickers.
    expect(screen.getByTestId("needs-group-approval").textContent).toContain("Approvals")
  })

  it("wires Approve to onApprove with the item id", () => {
    const { onApprove } = renderView([item("wi_private_approval", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("needs-approve"))
    expect(onApprove).toHaveBeenCalledWith("wi_private_approval")
  })

  it("marks a pending gate that is reserved for the operator", () => {
    renderView([item("wi_reserved", "in_review", "pending", { approvalOperatorOnly: true })])
    expect(screen.getByTestId("needs-operator-only")).toBeTruthy()
  })

  it("leaves an ordinary pending gate unmarked", () => {
    renderView([item("wi_ordinary", "in_review", "pending")])
    expect(screen.queryByTestId("needs-operator-only")).toBeNull()
  })

  it("Reject… opens the composer and decides NOTHING until the operator submits", () => {
    const { onReject } = renderView([item("wi_private_approval", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("needs-reject"))
    expect(onReject).not.toHaveBeenCalled()
    // Typing feedback and wandering off is not a decision either.
    const note = screen.getByTestId("needs-reject-note")
    fireEvent.change(note, { target: { value: "half a thou" } })
    fireEvent.blur(note)
    expect(onReject).not.toHaveBeenCalled()
  })

  it("carries the feedback in the SAME rejection that decides", () => {
    const { onReject } = renderView([item("wi_private_approval", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("needs-reject"))
    fireEvent.change(screen.getByTestId("needs-reject-note"), { target: { value: "needs a citation" } })
    fireEvent.click(screen.getByTestId("needs-reject-confirm"))
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledWith("wi_private_approval", "needs a citation")
  })

  it("names the consequence of the note it is about to send", () => {
    renderView([item("wi_private_approval", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("needs-reject"))
    expect(screen.getByTestId("needs-reject-consequence").textContent).toContain("Ends the work")
    expect(screen.getByTestId("needs-reject-confirm").textContent).toContain("Reject")
    fireEvent.change(screen.getByTestId("needs-reject-note"), { target: { value: "needs a citation" } })
    expect(screen.getByTestId("needs-reject-consequence").textContent).toContain("another round")
    expect(screen.getByTestId("needs-reject-confirm").textContent).toContain("Send back")
  })

  it("an empty rejection still decides — it is the stop, submitted deliberately", () => {
    const { onReject } = renderView([item("wi_private_approval", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("needs-reject"))
    fireEvent.click(screen.getByTestId("needs-reject-confirm"))
    expect(onReject).toHaveBeenCalledWith("wi_private_approval", "")
  })

  it("Unblock… lists the legal exits from legalTargets() and commits the chosen transition", async () => {
    setWorkItemStatus.mockResolvedValue({ workItem: {}, escalated: false })
    renderView([item("wi_private_blocked", "blocked", null, { title: "Blocked item" })])
    const trigger = screen.getByTestId("needs-unblock")
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
    fireEvent.click(trigger)
    // The legality module's edges from blocked (manual-start rule: never
    // executing) — backlog and assigned lead the manual exits.
    const backlog = await screen.findByTestId("needs-unblock-backlog")
    expect(screen.getByTestId("needs-unblock-assigned")).toBeTruthy()
    expect(screen.queryByTestId("needs-unblock-executing")).toBeNull()
    fireEvent.click(backlog)
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("wi_private_blocked", "backlog", undefined))
  })

  it("Route… on an escalated item offers the human exits and commits through the same lane", async () => {
    setWorkItemStatus.mockResolvedValue({ workItem: {}, escalated: false })
    renderView([item("wi_private_escalated", "escalated", null)])
    const trigger = screen.getByTestId("needs-route")
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
    fireEvent.click(trigger)
    const review = await screen.findByTestId("needs-route-in_review")
    expect(screen.queryByTestId("needs-route-executing")).toBeNull()
    fireEvent.click(review)
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("wi_private_escalated", "in_review", undefined))
  })

  it("the voice quotes the blocked reason note from detail enrichment", async () => {
    getWorkItem.mockImplementation((id: string) =>
      Promise.resolve({
        workItem: { id, version: 3, rounds: 0, source: "cron", verifyPolicy: null },
        spendUsd: 0,
        events: [
          {
            id: "e1", workItemId: id, kind: "status_change", fromStatus: "executing",
            toStatus: "blocked", actor: "mason", detail: { note: "Waiting on vendor sandbox keys" },
            createdAt: "2026-07-04T09:00:00.000Z",
          },
        ],
      }),
    )
    renderView([item("wi_private_blocked", "blocked", null)])
    await waitFor(() => expect(screen.getByText("Waiting on vendor sandbox keys")).toBeTruthy())
  })

  it("optimistically hides a card while it is resolving", () => {
    renderView([item("wi_private_approval", "in_review", "pending")], new Set(["wi_private_approval"]))
    expect(screen.queryByTestId("needs-approve")).toBeNull()
    expect(screen.getByTestId("needs-you-empty")).toBeTruthy()
  })

  // QA regression 2026-07-10: the gateway's sessionRef is { sessionId, ref? } —
  // an unassigned session-sourced approval must render (it used to crash the
  // whole lens reading `.id` off the real shape).
  it("renders an unassigned session-sourced approval from the real sessionRef shape", () => {
    renderView([
      item("sess", "in_review", "pending", {
        source: "session",
        sourceRef: "session:sess_1234567890abcdef:launch-note",
        sessionRef: { sessionId: "sess_1234567890abcdef", ref: "launch-note" },
      }),
      item("bare", "in_review", "pending", {
        source: "session",
        sourceRef: "session:sess_zz999",
        sessionRef: { sessionId: "sess_zz999" },
      }),
    ])
    expect(screen.getAllByTestId("needs-item")).toHaveLength(2)
    expect(screen.getByText("Session · launch-note")).toBeTruthy()
    // No ref suffix → the shortened session id, never a crash.
    expect(screen.getByText("Session · sess_zz999")).toBeTruthy()
  })

  it("never renders an opaque work-item id from identity or reference fields (the ID line renders public ids only)", () => {
    const { container } = renderView([
      item("wi_private_card", "in_review", "pending", {
        sourceRef: "workflow:wi_private_source:run",
        approvalRef: "wi_private_approval",
      }),
    ])
    expect(container.innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
  })

  it("the ID line renders the public id + status phrase (PLA-26 · In review)", () => {
    renderView([item("PLA-26", "in_review", "pending")])
    expect(screen.getByText("PLA-26 · In review")).toBeTruthy()
  })
})
