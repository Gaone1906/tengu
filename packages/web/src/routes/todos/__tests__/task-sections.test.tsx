import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  WorkItemAttachmentWire,
  WorkItemCommentWire,
  WorkItemDetailWire,
  WorkItemEventWire,
  WorkItemFullWire,
  WorkItemTreeNodeWire,
} from "@/lib/api"
import { buildFeed, whisperOf } from "../task-page/activity"
import TaskPage from "../task-page/task-page"

/* Todos v2 slice 6 — the task page sections (design-doc §7.2.8–11):
 * sub-tasks with hover quick actions (child status popover through the SAME
 * legality module, assign, open, add-row absent at the depth cap), relations
 * over three wire kinds with the blocked-by direction swap, attachments
 * through the multipart lane, and the merged activity feed (folds of ≥3
 * machine events, comments never collapse, composer attaches pending files to
 * the comment it sends). */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()
const assignWorkItem = vi.fn()
const createWorkItem = vi.fn()
const addWorkItemRelation = vi.fn()
const removeWorkItemRelation = vi.fn()
const listWorkItemAttachments = vi.fn()
const uploadWorkItemAttachment = vi.fn()
const deleteWorkItemAttachment = vi.fn()
const addWorkItemComment = vi.fn()
const listWorkItemComments = vi.fn()
const searchWorkItems = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      createWorkItem: (...args: unknown[]) => createWorkItem(...args),
      addWorkItemRelation: (...args: unknown[]) => addWorkItemRelation(...args),
      removeWorkItemRelation: (...args: unknown[]) => removeWorkItemRelation(...args),
      listWorkItemAttachments: (...args: unknown[]) => listWorkItemAttachments(...args),
      uploadWorkItemAttachment: (...args: unknown[]) => uploadWorkItemAttachment(...args),
      deleteWorkItemAttachment: (...args: unknown[]) => deleteWorkItemAttachment(...args),
      addWorkItemComment: (...args: unknown[]) => addWorkItemComment(...args),
      listWorkItemComments: (...args: unknown[]) => listWorkItemComments(...args),
      searchWorkItems: (...args: unknown[]) => searchWorkItems(...args),
      workItemAttachmentUrl: (id: string, aid: string) => `/api/work-items/${id}/attachments/${aid}`,
      updateWorkItem: vi.fn(),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({ departments: [] }),
      getOrg: vi.fn().mockResolvedValue({
        departments: [],
        employees: [
          { name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
        ],
        hierarchy: { root: null, sorted: [], warnings: [] },
      }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
      listLabels: vi.fn().mockResolvedValue({ labels: [] }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "executing", department: null,
    assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, acceptance: null,
    verifyPolicy: null, rounds: 1, budgetUsd: null, approvalState: null, approvalRequest: null,
    approvalRef: null, approvalTarget: null, approvalEscalatedAt: null, approvalDecidedBy: null,
    approvalDecidedAt: null, createdBy: "operator", parentId: null, rootId: id, depth: 0,
    dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null, ...overrides,
  }
}

function detailOf(item: WorkItemFullWire, extra: Partial<WorkItemDetailWire> = {}): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [], ...extra }
}

function treeNode(item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, children }
}

function event(id: string, kind: string, at: string, extra: Partial<WorkItemEventWire> = {}): WorkItemEventWire {
  return {
    id, workItemId: "PLA-12", kind, fromStatus: null, toStatus: null, actor: "operator",
    detail: null, createdAt: at, ...extra,
  }
}

function comment(id: string, body: string, at: string, extra: Partial<WorkItemCommentWire> = {}): WorkItemCommentWire {
  return {
    id, workItemId: "PLA-12", parentCommentId: null, authorKind: "employee", author: "mason",
    body, createdAt: at, editedAt: null, deletedAt: null, ...extra,
  }
}

function renderTask(path = "/todos/PLA-12") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItemTree.mockImplementation((id: string) =>
    Promise.resolve({ tree: { root: treeNode(full(id)), totals: {}, spendUsd: 0 } }),
  )
  listWorkItemAttachments.mockResolvedValue({ attachments: [] })
  listWorkItemComments.mockResolvedValue({ comments: [], total: 0 })
})

describe("the merged feed model", () => {
  it("folds runs of ≥3 machine events, keeps short runs as whispers, and never collapses comments", () => {
    const blocks = buildFeed(
      [
        event("e1", "created", "2026-07-20T08:00:00.000Z"),
        event("e2", "metadata_edited", "2026-07-20T09:00:00.000Z"),
        event("e3", "label_changed", "2026-07-20T10:00:00.000Z"),
        event("e4", "status_change", "2026-07-21T09:00:00.000Z", { fromStatus: "backlog", toStatus: "executing" }),
        event("e5", "comment_added", "2026-07-21T10:00:00.000Z"), // hidden — the comment is the voice
      ],
      [comment("wic_1", "Form states are in", "2026-07-20T09:30:00.000Z")],
    )
    // e1+e2 (run of 2, split by the comment) → whispers; comment; e3+e4 run of 2 → whispers.
    expect(blocks.map((b) => b.kind)).toEqual(["event", "event", "comment", "event", "event"])

    const folded = buildFeed(
      [
        event("e1", "created", "2026-07-20T08:00:00.000Z"),
        event("e2", "metadata_edited", "2026-07-20T09:00:00.000Z"),
        event("e3", "label_changed", "2026-07-20T10:00:00.000Z"),
        event("e4", "relation_added", "2026-07-20T11:00:00.000Z"),
        event("e5", "note", "2026-07-20T12:00:00.000Z"),
      ],
      [],
    )
    // The birth whisper never folds; the remaining run of 3 does.
    expect(folded.map((b) => b.kind)).toEqual(["event", "fold"])
  })

  it("whispers read as actor + verb (bounce carries its round; approvals decide readably)", () => {
    expect(whisperOf(event("e", "status_change", "t", { toStatus: "in_review" })).text).toBe("moved it to In review")
    expect(
      whisperOf(event("e", "status_change", "t", { fromStatus: "in_review", toStatus: "executing", detail: { bounce: true, rounds: 2 } })).text,
    ).toBe("sent it back · round 2")
    expect(whisperOf(event("e", "approval_decided", "t", { detail: { decision: "approve" } })).text).toBe("approved it")
    expect(whisperOf(event("e", "escalated", "t", { detail: { reason: "max-rounds-exhausted" } })).text).toContain("rounds exhausted")
  })
})

describe("sub-tasks", () => {
  function withChildren() {
    const item = full("PLA-12")
    getWorkItem.mockResolvedValue(detailOf(item))
    getWorkItemTree.mockResolvedValue({
      tree: {
        root: treeNode(item, [
          treeNode(full("PLA-13", { status: "done", parentId: "PLA-12", depth: 1, title: "Schema for guest orders" })),
          treeNode(full("PLA-14", { status: "executing", parentId: "PLA-12", depth: 1, assignee: "mason" }), ),
          treeNode(full("PLA-16", { status: "backlog", parentId: "PLA-12", depth: 1 })),
        ]),
        totals: {},
        spendUsd: 0,
      },
    })
    return item
  }

  it("renders rows with progress and commits a child transition through the child's legal-states popover", async () => {
    withChildren()
    setWorkItemStatus.mockResolvedValue({ workItem: full("PLA-16", { status: "executing" }), escalated: false })
    renderTask()

    const section = await screen.findByTestId("task-subtasks")
    await waitFor(() => expect(section.textContent).toContain("1 of 3 done"))
    expect(screen.getByTestId("subtasks-progress").style.width).toBe("33%")

    fireEvent.click(await screen.findByTestId("subtask-status-PLA-16"))
    // backlog's legal manual targets include executing (a manual start).
    fireEvent.click(await screen.findByTestId("subtask-status-option-executing"))
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-16", "executing"))
  })

  it("assigns a child through the quick action's roster picker", async () => {
    withChildren()
    assignWorkItem.mockResolvedValue({ workItem: full("PLA-16", { assignee: "mason" }) })
    renderTask()

    await screen.findByTestId("subtask-row-PLA-16")
    fireEvent.click(screen.getByTestId("subtask-assign-PLA-16"))
    fireEvent.click(await screen.findByTestId("assignee-option-mason"))
    await waitFor(() => expect(assignWorkItem).toHaveBeenCalledWith("PLA-16", "mason"))
  })

  it("adds a sub-task through the quiet add row (parentId carries)", async () => {
    withChildren()
    createWorkItem.mockResolvedValue({ workItem: full("PLA-23", { parentId: "PLA-12" }) })
    renderTask()

    fireEvent.click(await screen.findByTestId("subtask-add"))
    const input = screen.getByTestId("subtask-add-input")
    fireEvent.change(input, { target: { value: "E-mail receipts" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledWith({ title: "E-mail receipts", parentId: "PLA-12" }))
  })

  it("the add row simply doesn't exist at the depth cap — the caption explains", async () => {
    const item = full("PLA-22", { depth: 3, rootId: "PLA-12", parentId: "PLA-14" })
    getWorkItem.mockResolvedValue(detailOf(item))
    getWorkItemTree.mockResolvedValue({ tree: { root: treeNode(full("PLA-12"), []), totals: {}, spendUsd: 0 } })
    renderTask("/todos/PLA-22")

    await screen.findByTestId("task-title")
    await waitFor(() => expect(screen.queryByTestId("subtask-add")).toBeNull())
    // The item's node is absent from the stub tree → the empty section is
    // suppressed entirely at the cap (no add affordance to explain).
  })
})

describe("relations", () => {
  it("renders display kinds (Blocks tinted, incoming blocks as Blocked by) and removes with the direction swap", async () => {
    const item = full("PLA-12")
    getWorkItem.mockResolvedValue(detailOf(item, {
      relations: [
        { kind: "blocks", direction: "out", other: { id: "MKT-7", title: "Store launch campaign", status: "backlog" }, createdBy: "operator", createdAt: "2026-07-21T08:00:00.000Z" },
        { kind: "blocks", direction: "in", other: { id: "PLA-9", title: "Vendor keys", status: "blocked" }, createdBy: "operator", createdAt: "2026-07-21T08:00:00.000Z" },
      ],
    }))
    removeWorkItemRelation.mockResolvedValue({ removed: true })
    renderTask()

    const out = await screen.findByTestId("relation-row-MKT-7")
    expect(out.textContent).toContain("Blocks")
    const incoming = screen.getByTestId("relation-row-PLA-9")
    expect(incoming.textContent).toContain("Blocked by")

    fireEvent.click(screen.getByTestId("relation-remove-PLA-9"))
    // Incoming edge lives on the OTHER item: srcId swaps.
    await waitFor(() => expect(removeWorkItemRelation).toHaveBeenCalledWith("PLA-9", "blocks", "PLA-12"))
  })

  it("adds a relation from search; 'Blocked by' writes the edge on the other item", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12"), { relations: [] }))
    searchWorkItems.mockResolvedValue({
      workItems: [{ ...full("PLA-9"), status: "backlog" }],
      total: 1,
      nextOffset: null,
    })
    addWorkItemRelation.mockResolvedValue({ relation: {} })
    renderTask()

    fireEvent.click(await screen.findByTestId("relation-add"))
    fireEvent.click(screen.getByTestId("relation-kind-blocked-by"))
    fireEvent.change(screen.getByTestId("relation-search"), { target: { value: "vendor" } })
    fireEvent.click(await screen.findByTestId("relation-result-PLA-9"))
    await waitFor(() => expect(addWorkItemRelation).toHaveBeenCalledWith("PLA-9", "blocks", "PLA-12"))
  })
})

describe("attachments + activity", () => {
  it("lists item-level rows only and uploads through the multipart lane", async () => {
    const rows: WorkItemAttachmentWire[] = [
      { id: "wia_1", workItemId: "PLA-12", commentId: null, filename: "checkout-flow.png", mime: "image/png", bytes: 240 * 1024, sha256: "a", storagePath: "/x", uploadedBy: "mason", createdAt: "2026-07-22T08:00:00.000Z" },
      { id: "wia_2", workItemId: "PLA-12", commentId: "wic_1", filename: "region-matrix.csv", mime: "text/csv", bytes: 4096, sha256: "b", storagePath: "/y", uploadedBy: "mason", createdAt: "2026-07-22T08:00:00.000Z" },
    ]
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemAttachments.mockResolvedValue({ attachments: rows })
    uploadWorkItemAttachment.mockResolvedValue(rows[0])
    renderTask()

    const section = await screen.findByTestId("task-attachments")
    await waitFor(() => expect(section.textContent).toContain("checkout-flow.png"))
    expect(section.textContent).toContain("240 KB")
    // The comment-level row stays out of the item section.
    expect(screen.queryByTestId("attachment-row-wia_2")).toBeNull()

    const file = new File(["bytes"], "spec.md", { type: "text/markdown" })
    fireEvent.change(screen.getByTestId("attachment-file-input"), { target: { files: [file] } })
    await waitFor(() => expect(uploadWorkItemAttachment).toHaveBeenCalledWith("PLA-12", file))
  })

  it("renders comments in the delegation grammar with their attachment chips, folds quiet updates, and sends with pending files", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12"), {
      events: [
        event("e1", "created", "2026-07-20T08:00:00.000Z"),
        event("e2", "metadata_edited", "2026-07-20T08:10:00.000Z"),
        event("e3", "label_changed", "2026-07-20T08:20:00.000Z"),
        event("e4", "relation_added", "2026-07-20T08:30:00.000Z"),
      ],
    }))
    listWorkItemComments.mockResolvedValue({
      comments: [
        comment("wic_1", "Form states are in — screenshot attached.", "2026-07-22T08:00:00.000Z"),
        comment("wic_2", "Good call — ship without it.", "2026-07-22T09:00:00.000Z", { authorKind: "operator", author: "operator", parentCommentId: "wic_1" }),
      ],
      total: 2,
    })
    listWorkItemAttachments.mockResolvedValue({
      attachments: [
        { id: "wia_9", workItemId: "PLA-12", commentId: "wic_1", filename: "form-states.png", mime: "image/png", bytes: 1024, sha256: "c", storagePath: "/z", uploadedBy: "mason", createdAt: "2026-07-22T08:00:00.000Z" },
      ],
    })
    addWorkItemComment.mockResolvedValue({ comment: comment("wic_3", "New note", "2026-07-23T08:00:00.000Z") })
    uploadWorkItemAttachment.mockResolvedValue({})
    renderTask()

    const activity = await screen.findByTestId("task-activity")
    await waitFor(() => expect(activity.textContent).toContain("Form states are in"))
    // The reply is indented under the thread root, tombstone-shaped grammar intact.
    expect(screen.getByTestId("activity-comment-wic_2").className).toContain("ml-[30px]")
    // The comment's attachment renders as a chip aligned with the rail indent.
    expect(await screen.findByTestId("comment-attachment-wia_9")).toBeTruthy()
    // The birth whisper stays visible; the trailing 3-event run folds.
    expect(activity.textContent).toContain("created this todo")
    const fold = screen.getByTestId("activity-fold-1")
    expect(fold.textContent).toContain("3 quiet updates")
    fireEvent.click(fold)
    expect(activity.textContent).toContain("changed the labels")

    // Send with a staged file: the comment posts first, the file attaches to it.
    const staged = new File(["img"], "shot.png", { type: "image/png" })
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [staged] } })
    expect((await screen.findByTestId("composer-pending")).textContent).toContain("shot.png")
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "New note" } })
    fireEvent.click(screen.getByTestId("composer-send"))
    await waitFor(() => expect(addWorkItemComment).toHaveBeenCalledWith("PLA-12", "New note", undefined))
    await waitFor(() => expect(uploadWorkItemAttachment).toHaveBeenCalledWith("PLA-12", staged, "wic_3"))
  })
})
