import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  WorkItemCommentWire,
  WorkItemDetailWire,
  WorkItemFullWire,
} from "@/lib/api"
import { ActivitySection } from "../task-page/activity"

const listWorkItemAttachments = vi.fn()
const listWorkItemComments = vi.fn()
const addWorkItemComment = vi.fn()
const uploadWorkItemAttachment = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItemAttachments: (...args: unknown[]) => listWorkItemAttachments(...args),
      listWorkItemComments: (...args: unknown[]) => listWorkItemComments(...args),
      addWorkItemComment: (...args: unknown[]) => addWorkItemComment(...args),
      uploadWorkItemAttachment: (...args: unknown[]) => uploadWorkItemAttachment(...args),
      editWorkItemComment: vi.fn(),
      deleteWorkItemComment: vi.fn(),
      workItemAttachmentUrl: (id: string, attachmentId: string) =>
        `/api/work-items/${id}/attachments/${attachmentId}`,
    },
  }
})

const COLLAPSE_THRESHOLD = 320

function full(): WorkItemFullWire {
  return {
    id: "WEB-12",
    version: 1,
    title: "Improve the activity feed",
    body: null,
    status: "executing",
    department: "platform",
    assignee: null,
    priority: 2,
    rank: null,
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
    createdBy: "operator",
    parentId: null,
    rootId: "WEB-12",
    depth: 0,
    dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:00:00.000Z",
    closedAt: null,
  }
}

function comment(id: string, body: string): WorkItemCommentWire {
  return {
    id,
    workItemId: "WEB-12",
    parentCommentId: null,
    authorKind: "employee",
    author: "platform-dev",
    body,
    createdAt: "2026-07-20T09:00:00.000Z",
    editedAt: null,
    deletedAt: null,
  }
}

function renderActivity(comments: WorkItemCommentWire[] = []) {
  const detail: WorkItemDetailWire = {
    workItem: full(),
    spendUsd: 0,
    events: [],
    comments: { comments, total: comments.length },
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ActivitySection
        detail={detail}
        byName={new Map()}
        mobile={false}
        announce={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listWorkItemAttachments.mockResolvedValue({ attachments: [] })
  listWorkItemComments.mockResolvedValue({ comments: [], total: 0 })
})

describe("activity comment markdown", () => {
  it("renders emphasis and links instead of literal markdown syntax", async () => {
    renderActivity([comment("wic_rich", "**bold** and a [link](https://x.test)")])

    const row = await screen.findByTestId("activity-comment-wic_rich")
    expect(within(row).getByText("bold").tagName).toBe("STRONG")
    expect(within(row).getByRole("link", { name: "link" }).getAttribute("href")).toBe("https://x.test")
    expect(row.textContent).not.toContain("**")
    expect(row.textContent).not.toContain("[link]")
  })

  it("highlights fenced code and removes pipeline HTML markers", async () => {
    renderActivity([
      comment(
        "wic_code",
        "<!-- pipeline-status -->\n```ts\nconst ready = true\n```\n<!-- /pipeline-status -->",
      ),
    ])

    const row = await screen.findByTestId("activity-comment-wic_code")
    await waitFor(() => expect(row.querySelector("pre")).not.toBeNull())
    expect(row.querySelector("pre")?.textContent).toContain("const ready = true")
    expect(row.textContent).not.toContain("<!--")
    expect(row.textContent).not.toContain("pipeline-status")
  })

  it("collapses only above the boundary, strips syntax from the preview, and toggles both ways", async () => {
    const longBody = `# Heading\n\n**bold** and \`code\`\n\n${"preview words ".repeat(30)}`
    expect(longBody.length).toBeGreaterThan(COLLAPSE_THRESHOLD)
    renderActivity([
      comment("wic_exact", "x".repeat(COLLAPSE_THRESHOLD)),
      comment("wic_long", longBody),
    ])

    const exact = await screen.findByTestId("activity-comment-wic_exact")
    expect(within(exact).queryByRole("button", { name: "Show more" })).toBeNull()

    const long = screen.getByTestId("activity-comment-wic_long")
    const more = within(long).getByRole("button", { name: "Show more" })
    expect(long.textContent).not.toContain("**")
    expect(long.textContent).not.toContain("#")
    expect(long.textContent).not.toContain("`")
    expect(long.querySelector(".line-clamp-3")).not.toBeNull()

    fireEvent.click(more)
    expect(within(long).getByRole("button", { name: "Show less" })).toBeTruthy()
    expect(within(long).getByText("bold").tagName).toBe("STRONG")
    expect(long.querySelector(".line-clamp-3")).toBeNull()

    fireEvent.click(within(long).getByRole("button", { name: "Show less" }))
    expect(within(long).getByRole("button", { name: "Show more" })).toBeTruthy()
    expect(long.querySelector(".line-clamp-3")).not.toBeNull()
  })
})

describe("the multiline comment composer", () => {
  it("keeps Shift+Enter as a newline and submits the two-line body on Enter", async () => {
    const user = userEvent.setup()
    addWorkItemComment.mockResolvedValue({
      comment: comment("wic_sent", "first line\nsecond line"),
    })
    renderActivity()

    const composer = await screen.findByTestId("composer-input")
    expect(composer.tagName).toBe("TEXTAREA")
    await user.click(composer)
    await user.type(composer, "first line{Shift>}{Enter}{/Shift}")
    expect(addWorkItemComment).not.toHaveBeenCalled()
    expect((composer as HTMLTextAreaElement).value).toBe("first line\n")

    await user.type(composer, "second line")
    await user.keyboard("{Enter}")
    await waitFor(() =>
      expect(addWorkItemComment).toHaveBeenCalledWith(
        "WEB-12",
        "first line\nsecond line",
        undefined,
      ),
    )
  })

  it("still stages an attachment pasted into the textarea", async () => {
    renderActivity()
    const composer = await screen.findByTestId("composer-input")
    const pasted = new File(["image"], "pasted.png", { type: "image/png" })

    fireEvent.paste(composer, { clipboardData: { files: [pasted] } })

    expect((await screen.findByTestId("composer-pending")).textContent).toContain("pasted.png")
  })
})
