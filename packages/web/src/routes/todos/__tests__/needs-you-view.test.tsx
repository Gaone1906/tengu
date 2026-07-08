import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { WorkItemCompactWire, WorkItemStatusWire, ApprovalStateWire } from "@/lib/api"
import { NeedsYouView } from "../needs-you-view"

function item(
  id: string,
  status: WorkItemStatusWire,
  approvalState: ApprovalStateWire | null,
  over: Partial<WorkItemCompactWire> = {},
): WorkItemCompactWire {
  return {
    id,
    title: `Item ${id}`,
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
      <NeedsYouView items={items} resolvingIds={resolvingIds} onApprove={onApprove} onSendBack={onSendBack} onEscalate={onEscalate} onOpen={onOpen} />
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
      item("blk", "blocked", null),
      item("ap", "in_review", "pending"),
      item("esc", "escalated", null),
    ])
    expect(screen.getByText("Approve posting this?")).toBeTruthy()
    expect(screen.getByText("Approval")).toBeTruthy()
    expect(screen.getByText("Escalated")).toBeTruthy()
    expect(screen.getByText("Blocked")).toBeTruthy()
    expect(screen.getAllByTestId(/needs-item-/).map((el) => el.getAttribute("data-testid"))).toEqual([
      "needs-item-blk",
      "needs-item-ap",
      "needs-item-esc",
    ])
  })

  it("wires Approve to onApprove with the item id", () => {
    const { onApprove } = renderView([item("ap", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("approve-ap"))
    expect(onApprove).toHaveBeenCalledWith("ap")
  })

  it("opens a send-back composer and posts the note", () => {
    const { onSendBack } = renderView([item("ap", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("sendback-ap"))
    fireEvent.change(screen.getByTestId("sendback-note-ap"), { target: { value: "needs a citation" } })
    fireEvent.click(screen.getByTestId("sendback-confirm-ap"))
    expect(onSendBack).toHaveBeenCalledWith("ap", "needs a citation")
  })

  it("wires escalation to onEscalate with the item id", () => {
    const { onEscalate } = renderView([item("ap", "in_review", "pending")])
    fireEvent.click(screen.getByTestId("escalate-ap"))
    expect(onEscalate).toHaveBeenCalledWith("ap")
  })

  it("optimistically hides a card while it is resolving", () => {
    renderView([item("ap", "in_review", "pending")], new Set(["ap"]))
    expect(screen.queryByTestId("approve-ap")).toBeNull()
    expect(screen.getByTestId("needs-you-empty")).toBeTruthy()
  })
})
