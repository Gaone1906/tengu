import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
import { ActivitySection, buildFeed, stripCommentMarkers, whisperOf } from "../task-page/activity"
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
const editWorkItemComment = vi.fn()
const deleteWorkItemComment = vi.fn()
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
      editWorkItemComment: (...args: unknown[]) => editWorkItemComment(...args),
      deleteWorkItemComment: (...args: unknown[]) => deleteWorkItemComment(...args),
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

function imageAttachment(
  id: string,
  filename: string,
  commentId: string | null = null,
): WorkItemAttachmentWire {
  return {
    id,
    workItemId: "PLA-12",
    commentId,
    filename,
    mime: "image/png",
    bytes: 1024,
    sha256: id,
    storagePath: `/tmp/${filename}`,
    uploadedBy: "operator",
    createdAt: "2026-07-22T08:00:00.000Z",
  }
}

function videoAttachment(
  id: string,
  filename: string,
  commentId: string | null = null,
): WorkItemAttachmentWire {
  return { ...imageAttachment(id, filename, commentId), mime: "video/mp4" }
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

function renderActivity(detail: WorkItemDetailWire) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ActivitySection detail={detail} byName={new Map()} mobile={false} announce={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, client }
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

  it("leaves inline HTML comments and fenced examples intact", () => {
    expect(stripCommentMarkers(
      "Before\n<!-- pipeline-status -->\nInline <!-- keep --> text\n<!-- keep --> visible <!-- too -->\n```\n<!-- code -->\n```\n<!-- /pipeline-status -->\nAfter",
    )).toBe("Before\nInline <!-- keep --> text\n<!-- keep --> visible <!-- too -->\n```\n<!-- code -->\n```\nAfter")
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
  it("previews and opens an item-level video in the shared player", async () => {
    const video = videoAttachment("wia_video", "walkthrough.mp4")
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemAttachments.mockResolvedValue({ attachments: [video] })
    renderTask()

    const tile = await screen.findByTestId("attachment-tile-wia_video")
    expect(tile.getAttribute("aria-label")).toBe("Play walkthrough.mp4")
    expect((screen.getByAltText("walkthrough.mp4 preview") as HTMLImageElement).getAttribute("src"))
      .toBe("/api/work-items/PLA-12/attachments/wia_video?poster=1")
    fireEvent.click(tile)
    const dialog = await screen.findByTestId("attachment-video-dialog")
    expect(within(dialog).getByLabelText("Play walkthrough.mp4")).toBeTruthy()
  })

  it("previews a comment-level video with the same player", async () => {
    const note = comment("wic_video", "Video attached", "2026-07-22T08:00:00.000Z")
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemComments.mockResolvedValue({ comments: [note], total: 1 })
    listWorkItemAttachments.mockResolvedValue({ attachments: [videoAttachment("wia_comment_video", "result.mp4", note.id)] })
    renderTask()

    fireEvent.click(await screen.findByTestId("comment-attachment-wia_comment_video"))
    const dialog = await screen.findByTestId("attachment-video-dialog")
    expect(within(dialog).getByLabelText("Play result.mp4")).toBeTruthy()
  })

  it("lists item-level rows only and uploads through the multipart lane", async () => {
    const rows: WorkItemAttachmentWire[] = [
      { id: "wia_1", workItemId: "PLA-12", commentId: null, filename: "checkout-flow.png", mime: "image/png", bytes: 240 * 1024, sha256: "a", storagePath: "/x", uploadedBy: "mason", createdAt: "2026-07-22T08:00:00.000Z" },
      { id: "wia_2", workItemId: "PLA-12", commentId: "wic_1", filename: "region-matrix.csv", mime: "text/csv", bytes: 4096, sha256: "b", storagePath: "/y", uploadedBy: "mason", createdAt: "2026-07-22T08:00:00.000Z" },
      { id: "wia_3", workItemId: "PLA-12", commentId: null, filename: "release-notes.pdf", mime: "application/pdf", bytes: 8192, sha256: "c", storagePath: "/z", uploadedBy: "mason", createdAt: "2026-07-22T08:00:00.000Z" },
    ]
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemAttachments.mockResolvedValue({ attachments: rows })
    uploadWorkItemAttachment.mockResolvedValue(rows[0])
    renderTask()

    await screen.findByTestId("task-attachments")
    const tile = await screen.findByTestId("attachment-tile-wia_1")
    expect(tile.getAttribute("aria-label")).toBe("Preview checkout-flow.png")
    const caption = screen.getByTestId("attachment-caption-wia_1")
    expect(caption.className).toContain("absolute")
    expect(caption.className).toContain("opacity-0")
    expect(caption.className).toContain("[@media(hover:hover)]:group-hover/tile:opacity-100")
    expect(caption.className).toContain("group-focus-within/tile:opacity-100")
    expect(caption.textContent).toContain("checkout-flow.png")
    expect(caption.textContent).toContain("240 KB")
    const fileRow = screen.getByTestId("attachment-row-wia_3")
    expect(fileRow.textContent).toContain("release-notes.pdf")
    expect(fileRow.textContent).toContain("8 KB")
    // The comment-level row stays out of the item section.
    expect(screen.queryByTestId("attachment-row-wia_2")).toBeNull()

    const file = new File(["bytes"], "spec.md", { type: "text/markdown" })
    fireEvent.change(screen.getByTestId("attachment-file-input"), { target: { files: [file] } })
    await waitFor(() => expect(uploadWorkItemAttachment).toHaveBeenCalledWith("PLA-12", file))
  })

  it("navigates the item image gallery with wrapping arrow keys and buttons", async () => {
    const first = imageAttachment("wia_first", "first.png")
    const second = imageAttachment("wia_second", "second.png")
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemAttachments.mockResolvedValue({ attachments: [first, second] })
    renderTask()

    const firstTile = await screen.findByTestId("attachment-tile-wia_first")
    fireEvent.click(firstTile)
    expect(screen.getByTestId("attachment-lightbox-image").getAttribute("alt")).toBe("first.png")

    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(screen.getByTestId("attachment-lightbox-image").getAttribute("alt")).toBe("second.png")

    fireEvent.click(screen.getByTestId("attachment-lightbox-prev"))
    expect(screen.getByTestId("attachment-lightbox-image").getAttribute("alt")).toBe("first.png")

    fireEvent.keyDown(window, { key: "ArrowLeft" })
    expect(screen.getByTestId("attachment-lightbox-image").getAttribute("alt")).toBe("second.png")

    fireEvent.click(screen.getByTestId("attachment-lightbox-next"))
    expect(screen.getByTestId("attachment-lightbox-image").getAttribute("alt")).toBe("first.png")
  })

  it("hides gallery arrows when only one image can be previewed", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemAttachments.mockResolvedValue({ attachments: [imageAttachment("wia_only", "only.png")] })
    renderTask()

    fireEvent.click(await screen.findByTestId("attachment-tile-wia_only"))
    expect(screen.queryByTestId("attachment-lightbox-prev")).toBeNull()
    expect(screen.queryByTestId("attachment-lightbox-next")).toBeNull()
  })

  it("closes from empty space or Escape, not the image, and restores tile focus", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemAttachments.mockResolvedValue({ attachments: [imageAttachment("wia_close", "close.png")] })
    renderTask()

    const tile = await screen.findByTestId("attachment-tile-wia_close")
    fireEvent.click(tile)
    const image = screen.getByTestId("attachment-lightbox-image")
    fireEvent.pointerDown(image, { pointerId: 1 })
    expect(screen.getByTestId("attachment-lightbox")).toBeTruthy()

    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("attachment-lightbox")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(tile))

    fireEvent.click(tile)
    fireEvent.pointerDown(screen.getByTestId("attachment-lightbox"), { pointerId: 1 })
    await waitFor(() => expect(screen.queryByTestId("attachment-lightbox")).toBeNull())
  })

  it("toggles, adjusts, and pans zoom before navigation resets the image to fit", async () => {
    const first = imageAttachment("wia_zoom", "zoom.png")
    const second = imageAttachment("wia_after", "after.png")
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemAttachments.mockResolvedValue({ attachments: [first, second] })
    renderTask()

    fireEvent.click(await screen.findByTestId("attachment-tile-wia_zoom"))
    let image = screen.getByTestId("attachment-lightbox-image")
    fireEvent.click(screen.getByTestId("attachment-lightbox-zoom"))
    expect(image.dataset.zoom).toBe("2")

    fireEvent.keyDown(window, { key: "0" })
    expect(image.dataset.zoom).toBe("1")
    fireEvent.keyDown(window, { key: "+" })
    expect(image.dataset.zoom).toBe("1.5")
    fireEvent.keyDown(window, { key: "-" })
    expect(image.dataset.zoom).toBe("1")

    fireEvent.doubleClick(image)
    expect(image.dataset.zoom).toBe("2")
    fireEvent.pointerDown(image, { pointerId: 1, clientX: 20, clientY: 30 })
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 45, clientY: 65 })
    fireEvent.pointerUp(image, { pointerId: 1 })
    expect(image.style.transform).toContain("translate(25px, 35px)")

    fireEvent.click(screen.getByTestId("attachment-lightbox-next"))
    image = screen.getByTestId("attachment-lightbox-image")
    expect(image.getAttribute("alt")).toBe("after.png")
    expect(image.dataset.zoom).toBe("1")
    expect(image.style.transform).toContain("translate(0px, 0px)")
  })

  it("keeps each comment's image gallery isolated from item and sibling images", async () => {
    const rootComment = comment("wic_gallery", "Gallery", "2026-07-22T08:00:00.000Z")
    const siblingComment = comment("wic_sibling", "Sibling", "2026-07-22T09:00:00.000Z")
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemComments.mockResolvedValue({ comments: [rootComment, siblingComment], total: 2 })
    listWorkItemAttachments.mockResolvedValue({
      attachments: [
        imageAttachment("wia_item", "item.png"),
        imageAttachment("wia_comment_a", "comment-a.png", "wic_gallery"),
        imageAttachment("wia_comment_b", "comment-b.png", "wic_gallery"),
        imageAttachment("wia_sibling", "sibling.png", "wic_sibling"),
      ],
    })
    renderTask()

    fireEvent.click(await screen.findByTestId("comment-attachment-wia_comment_a"))
    expect(screen.getByTestId("attachment-lightbox-image").getAttribute("alt")).toBe("comment-a.png")
    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(screen.getByTestId("attachment-lightbox-image").getAttribute("alt")).toBe("comment-b.png")
    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(screen.getByTestId("attachment-lightbox-image").getAttribute("alt")).toBe("comment-a.png")
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

    await waitFor(() => expect(screen.queryByTestId("task-page-skeleton")).toBeNull())
    const activity = screen.getByTestId("task-activity")
    await waitFor(() => expect(activity.textContent).toContain("Form states are in"))
    // The reply is indented under the thread root, tombstone-shaped grammar intact.
    expect(screen.getByTestId("activity-comment-wic_2").className).toContain("ml-[30px]")
    // The comment's attachment renders as a chip aligned with the rail indent.
    expect(await screen.findByTestId("comment-attachment-wia_9")).toBeTruthy()
    // The birth whisper stays visible; the trailing 3-event run folds.
    expect(activity.textContent).toContain("created this todo")
    const fold = screen.getByTestId("activity-fold-e2")
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

  it("renders comment markdown and line breaks while hiding pipeline markers", async () => {
    const body = [
      "<!-- pipeline-status -->",
      "**PLAN done** and `code`",
      "- item",
      "1. item",
      "[text](https://example.com)",
      "<!-- /pipeline-status -->",
    ].join("\n")
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemComments.mockResolvedValue({
      comments: [comment("wic_markdown", body, "2026-07-22T08:00:00.000Z")],
      total: 1,
    })
    renderTask()

    const block = await screen.findByTestId("activity-comment-wic_markdown")
    expect(block.querySelector("strong")?.textContent).toBe("PLAN done")
    expect(block.querySelector("code")?.textContent).toBe("code")
    expect(block.querySelector('a[href="https://example.com"]')?.textContent).toBe("text")
    expect(block.textContent).not.toContain("**")
    expect(block.textContent).not.toContain("`")
    expect(block.textContent).not.toContain("pipeline-status")

    expect(block.querySelector("ul li")?.textContent?.trim()).toBe("item")
    expect(block.querySelector("ol li")?.textContent?.replace(/\s+/g, " ").trim()).toBe("item text")
  })

  it("shows newest blocks first, keeps replies chronological, and expands quiet updates newest first", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12"), {
      events: [
        event("e1", "created", "2026-07-20T08:00:00.000Z"),
        event("e2", "metadata_edited", "2026-07-20T09:00:00.000Z"),
        event("e3", "label_changed", "2026-07-20T10:00:00.000Z"),
        event("e4", "relation_added", "2026-07-20T11:00:00.000Z"),
      ],
    }))
    listWorkItemComments.mockResolvedValue({
      comments: [
        comment("wic_parent", "Parent", "2026-07-21T08:00:00.000Z"),
        comment("wic_reply_1", "First reply", "2026-07-21T09:00:00.000Z", { parentCommentId: "wic_parent" }),
        comment("wic_reply_2", "Second reply", "2026-07-21T10:00:00.000Z", { parentCommentId: "wic_parent" }),
        comment("wic_newest", "Newest", "2026-07-22T08:00:00.000Z"),
      ],
      total: 4,
    })
    renderTask()

    await screen.findByTestId("activity-comment-wic_newest")
    const activity = screen.getByTestId("task-activity")
    const comments = [...activity.querySelectorAll('[data-testid^="activity-comment-"]')]
      .map((node) => node.getAttribute("data-testid"))
    expect(comments).toEqual([
      "activity-comment-wic_newest",
      "activity-comment-wic_parent",
      "activity-comment-wic_reply_1",
      "activity-comment-wic_reply_2",
    ])

    const fold = screen.getByTestId("activity-fold-e2")
    fireEvent.click(fold)
    const expandedEvents = [...fold.parentElement!.querySelectorAll('[data-testid^="whisper-"]')]
      .map((node) => node.getAttribute("data-testid"))
    expect(expandedEvents).toEqual(["whisper-e4", "whisper-e3", "whisper-e2"])
  })

  it("places the desktop composer after the feed and keeps an expanded fold open when a newer comment is prepended", async () => {
    const events = [
      event("e1", "created", "2026-07-20T08:00:00.000Z"),
      event("e2", "metadata_edited", "2026-07-20T09:00:00.000Z"),
      event("e3", "label_changed", "2026-07-20T10:00:00.000Z"),
      event("e4", "relation_added", "2026-07-20T11:00:00.000Z"),
    ]
    const older = comment("wic_older", "Older", "2026-07-21T08:00:00.000Z")
    const detail = detailOf(full("PLA-12"), {
      events,
      comments: { comments: [older], total: 1 },
    })
    const { client } = renderActivity(detail)

    const fold = await screen.findByTestId("activity-fold-e2")
    const composer = screen.getByTestId("task-composer")
    const olderBlock = screen.getByTestId("activity-comment-wic_older")
    expect(olderBlock.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(fold)
    expect(fold.getAttribute("aria-expanded")).toBe("true")

    const newer = comment("wic_newer", "Newer", "2026-07-22T08:00:00.000Z")
    act(() => {
      client.setQueryData(["work-item-comments", "PLA-12"], {
        comments: [newer, older],
        total: 2,
      })
    })

    expect(await screen.findByTestId("activity-comment-wic_newer")).toBeTruthy()
    expect(screen.getByTestId("activity-fold-e2").getAttribute("aria-expanded")).toBe("true")
  })

  it("keeps tombstones italic and renders deleted text instead of stored markdown", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemComments.mockResolvedValue({
      comments: [
        comment("wic_deleted", "**should stay hidden**", "2026-07-22T08:00:00.000Z", {
          deletedAt: "2026-07-23T09:00:00.000Z",
        }),
      ],
      total: 1,
    })
    renderTask()

    const block = await screen.findByTestId("activity-comment-wic_deleted")
    const deleted = block.querySelector("span.italic")
    expect(deleted?.textContent).toBe("[deleted]")
    expect(block.textContent).not.toContain("should stay hidden")
  })

  it("carries comment edit/delete from the retired sheet: Edit only on operator-authored, Delete on any, wire round-trips (cutover)", async () => {
    const rawBody = "**operator words**\n`raw code`"
    const editedBody = "**operator words v2**\n`raw code`\n"
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    listWorkItemComments.mockResolvedValue({
      comments: [
        comment("wic_mine", rawBody, "2026-07-22T08:00:00.000Z", { authorKind: "operator", author: "operator" }),
        comment("wic_theirs", "agent words", "2026-07-22T09:00:00.000Z"),
      ],
      total: 2,
    })
    editWorkItemComment.mockResolvedValue({ comment: comment("wic_mine", editedBody, "2026-07-22T08:00:00.000Z", { authorKind: "operator", author: "operator", editedAt: "2026-07-23T09:00:00.000Z" }) })
    deleteWorkItemComment.mockResolvedValue({ comment: comment("wic_theirs", "", "2026-07-22T09:00:00.000Z", { deletedAt: "2026-07-23T09:00:00.000Z" }) })
    renderTask()

    await screen.findByTestId("activity-comment-wic_mine")
    // Edit authority: only the operator's own words edit here.
    expect(screen.getByTestId("activity-edit-start-wic_mine")).toBeTruthy()
    expect(screen.queryByTestId("activity-edit-start-wic_theirs")).toBeNull()
    expect(screen.getByTestId("activity-delete-wic_theirs")).toBeTruthy()

    fireEvent.click(screen.getByTestId("activity-edit-start-wic_mine"))
    const editBox = screen.getByTestId("activity-edit-wic_mine") as HTMLTextAreaElement
    expect(editBox.value).toBe(rawBody)
    fireEvent.change(editBox, { target: { value: editedBody } })
    fireEvent.click(screen.getByTestId("activity-edit-save-wic_mine"))
    await waitFor(() => expect(editWorkItemComment).toHaveBeenCalledWith("PLA-12", "wic_mine", editedBody))

    fireEvent.click(screen.getByTestId("activity-delete-wic_theirs"))
    await waitFor(() => expect(deleteWorkItemComment).toHaveBeenCalledWith("PLA-12", "wic_theirs"))
  })
})
