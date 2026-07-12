import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { WorkItemCompactWire, WorkItemStatusWire, ApprovalStateWire } from "@/lib/api"
import { NeedsYouView } from "../needs-you-view"

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { employeeOverrides: {} } }),
}))

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

function renderView(items: WorkItemCompactWire[], resolvingIds = new Set<string>(), handlers: Partial<Parameters<typeof NeedsYouView>[0]> = {}) {
  const onApprove = handlers.onApprove ?? vi.fn()
  const onSendBack = handlers.onSendBack ?? vi.fn()
  const onEscalate = handlers.onEscalate ?? vi.fn()
  const onOpen = handlers.onOpen ?? vi.fn()
  render(
    <MemoryRouter>
      <NeedsYouView items={items} byName={new Map()} resolvingIds={resolvingIds} onApprove={onApprove} onSendBack={onSendBack} onEscalate={onEscalate} onOpen={onOpen} />
    </MemoryRouter>,
  )
  return { onApprove, onSendBack, onEscalate, onOpen }
}

describe("NeedsYouView", () => {
  it("shows the resting empty state when nothing needs the caller", () => {
    renderView([])
    expect(screen.getByTestId("needs-you-empty")).toBeTruthy()
    expect(screen.getByText("Nothing needs you.")).toBeTruthy()
  })

  it("renders server-ordered approval, escalated, and blocked items", () => {
    renderView([
      item("wi_private_blocked", "blocked", null, { title: "Blocked item" }),
      item("wi_private_approval", "in_review", "pending", { title: "Approval item" }),
      item("wi_private_escalated", "escalated", null, { title: "Escalated item" }),
    ])
    expect(screen.getByText("Approve posting this?")).toBeTruthy()
    expect(screen.getByText("Approval")).toBeTruthy()
    expect(screen.getByText("Escalated")).toBeTruthy()
    expect(screen.getByText("Blocked")).toBeTruthy()
    expect(screen.getAllByTestId("needs-item").map((el) => el.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("Blocked item"),
      expect.stringContaining("Approval item"),
      expect.stringContaining("Escalated item"),
    ]))
  })

  it("wires Approve to onApprove with the item id", () => {
    const { onApprove } = renderView([item("wi_private_approval", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("needs-approve"))
    expect(onApprove).toHaveBeenCalledWith("wi_private_approval")
  })

  it("opens a send-back composer and posts the note", () => {
    const { onSendBack } = renderView([item("wi_private_approval", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("needs-sendback"))
    fireEvent.change(screen.getByTestId("needs-sendback-note"), { target: { value: "needs a citation" } })
    fireEvent.click(screen.getByTestId("needs-sendback-confirm"))
    expect(onSendBack).toHaveBeenCalledWith("wi_private_approval", "needs a citation")
  })

  it("wires escalation to onEscalate with the item id", () => {
    const { onEscalate } = renderView([item("wi_private_approval", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("needs-escalate"))
    expect(onEscalate).toHaveBeenCalledWith("wi_private_approval")
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

  it("never renders an opaque work-item id from identity or reference fields", () => {
    const { container } = render(
      <MemoryRouter>
        <NeedsYouView
          items={[item("wi_private_card", "in_review", "pending", {
            sourceRef: "workflow:wi_private_source:run",
            approvalRef: "wi_private_approval",
          })]}
          byName={new Map()}
          resolvingIds={new Set()}
          onApprove={() => {}}
          onSendBack={() => {}}
          onEscalate={() => {}}
          onOpen={() => {}}
        />
      </MemoryRouter>,
    )
    expect(container.innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
  })
})
