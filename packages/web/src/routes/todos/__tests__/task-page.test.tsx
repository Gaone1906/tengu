import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemStatusWire, WorkItemTreeNodeWire } from "@/lib/api"
import TaskPage, { ancestorsOf, nodeOf } from "../task-page/task-page"

/* Todos v2 slice 6 stage B — the task page (design-doc §7, task-detail.html).
 * Anatomy: breadcrumb trail from the root tree, banner precedence
 * (escalated > approval > blocked, ONE at a time), the banner's asked-for-after
 * reason field (review F6), and the chrome-free rail's read rows. Stage C adds
 * the §8 full-screen push: on mobile the tab bar yields the bottom edge to the
 * fixed comment bar. */

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children, hideMobileTabBar }: { children: React.ReactNode; hideMobileTabBar?: boolean }) => (
    <div data-testid="page-layout" data-hide-mobile-tab-bar={hideMobileTabBar ? "true" : "false"}>{children}</div>
  ),
}))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()
const decideWorkItemApproval = vi.fn()
const listWorkItemAttachments = vi.fn()
const listWorkItemComments = vi.fn()
const listWorkItemSessions = vi.fn()
const getOrg = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      decideWorkItemApproval: (...args: unknown[]) => decideWorkItemApproval(...args),
      listWorkItemAttachments: (...args: unknown[]) => listWorkItemAttachments(...args),
      listWorkItemComments: (...args: unknown[]) => listWorkItemComments(...args),
      workItemAttachmentUrl: (id: string, attachmentId: string) =>
        `/api/work-items/${id}/attachments/${attachmentId}`,
      listWorkItemSessions: (...args: unknown[]) => listWorkItemSessions(...args),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 }],
      }),
      getOrg: (...args: unknown[]) => getOrg(...args),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id,
    version: 3,
    title: `Item ${id}`,
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
    rounds: 1,
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
    rootId: id,
    depth: 0,
    dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null,
    ...overrides,
  }
}

function detailOf(item: WorkItemFullWire, extra: Partial<WorkItemDetailWire> = {}): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [], ...extra }
}

function treeNode(item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, children }
}

function renderTask(path = "/todos/PLA-12", state?: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[state ? { pathname: path, state } : path]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
          <Route path="/todos/b/:board" element={<div data-testid="board-probe" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** jsdom has no matchMedia; the page's ONE mobile breakpoint is 700px. */
function stubMobileViewport() {
  const mql = (matches: boolean) => ({
    matches,
    media: "",
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
  window.matchMedia = ((query: string) => mql(query === "(max-width: 700px)")) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItemTree.mockImplementation((id: string) =>
    Promise.resolve({ tree: { root: treeNode(full(id)), totals: {}, spendUsd: 0 } }),
  )
  listWorkItemAttachments.mockResolvedValue({ attachments: [] })
  listWorkItemComments.mockResolvedValue({ comments: [], total: 0 })
  listWorkItemSessions.mockResolvedValue([])
  getOrg.mockResolvedValue({
    departments: ["platform"],
    employees: [],
    hierarchy: { root: null, sorted: [], warnings: [] },
  })
})

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe("ancestor helpers", () => {
  const root = treeNode(full("PLA-1"), [
    treeNode(full("PLA-2", { parentId: "PLA-1", depth: 1 }), [
      treeNode(full("PLA-4", { parentId: "PLA-2", depth: 2 })),
    ]),
    treeNode(full("PLA-3", { parentId: "PLA-1", depth: 1 })),
  ])

  it("derives the ancestor trail root-first", () => {
    expect(ancestorsOf(root, "PLA-4").map((a) => a.id)).toEqual(["PLA-1", "PLA-2"])
    expect(ancestorsOf(root, "PLA-1")).toEqual([])
    expect(ancestorsOf(root, "PLA-9")).toEqual([])
  })

  it("finds the item's own node", () => {
    expect(nodeOf(root, "PLA-4")?.id).toBe("PLA-4")
    expect(nodeOf(root, "PLA-9")).toBeUndefined()
  })
})

describe("the task page", () => {
  it("holds the loaded task geometry with a skeleton until the detail resolves", async () => {
    let resolveDetail!: (detail: WorkItemDetailWire) => void
    getWorkItem.mockImplementation(
      () => new Promise<WorkItemDetailWire>((resolve) => {
        resolveDetail = resolve
      }),
    )
    renderTask()

    expect(screen.getByTestId("task-page-skeleton")).toBeTruthy()
    expect(screen.getByTestId("task-banner-skeleton")).toBeTruthy()
    expect(screen.getByTestId("task-details-toggle")).toBeTruthy()
    expect(screen.getByTestId("task-activity")).toBeTruthy()

    await act(async () => {
      resolveDetail(detailOf(full("PLA-12")))
    })
    await waitFor(() => expect(screen.queryByTestId("task-page-skeleton")).toBeNull())
    expect(screen.getByTestId("task-details-toggle")).toBeTruthy()
    expect(screen.getByTestId("task-activity")).toBeTruthy()
  })

  it("reserves a two-line mobile title while the detail is pending", () => {
    stubMobileViewport()
    getWorkItem.mockImplementation(() => new Promise(() => {}))
    renderTask()

    expect(screen.getByTestId("task-id-skeleton").className).toContain("h-[18px]")
    expect(screen.getByTestId("task-title-skeleton").className).toContain("h-[62px]")
  })

  it("keeps the crumb and chip bands single-height while second-wave data lands", async () => {
    const item = full("PLA-12", { rootId: "PLA-1", parentId: "PLA-1", assignee: "platform-dev" })
    let resolveTree!: (value: { tree: { root: WorkItemTreeNodeWire; totals: {}; spendUsd: number } }) => void
    let resolveSessions!: (value: Array<{ status: string }>) => void
    getWorkItem.mockResolvedValue(detailOf(item))
    getWorkItemTree.mockImplementation(
      () => new Promise((resolve) => {
        resolveTree = resolve
      }),
    )
    listWorkItemSessions.mockImplementation(
      () => new Promise((resolve) => {
        resolveSessions = resolve
      }),
    )
    getOrg.mockResolvedValue({
      departments: ["platform"],
      employees: [{
        name: "platform-dev",
        displayName: "Platform Engineer With A Long Name",
        department: "platform",
        rank: "senior",
        engine: "codex",
        model: "default",
        persona: "Builds the platform",
      }],
      hierarchy: { root: null, sorted: [], warnings: [] },
    })
    renderTask()

    const crumbBefore = await screen.findByTestId("task-crumb-bar")
    const chipsBefore = await screen.findByTestId("task-chip-cluster")
    expect(crumbBefore.className).toContain("min-h-[56px]")
    expect(chipsBefore.className).toContain("max-[700px]:flex-nowrap")
    expect(chipsBefore.querySelectorAll(":scope > button")).toHaveLength(3)

    await act(async () => {
      resolveTree({
        tree: {
          root: treeNode(full("PLA-1"), [treeNode(item)]),
          totals: {},
          spendUsd: 0,
        },
      })
      resolveSessions([{ status: "running" }])
    })

    await waitFor(() => expect(screen.getByTestId("task-crumb-PLA-1")).toBeTruthy())
    expect(screen.getByTestId("task-crumb-bar").className).toBe(crumbBefore.className)
    expect(screen.getByTestId("task-chip-cluster").className).toBe(chipsBefore.className)
    expect(screen.getByTestId("task-chip-cluster").querySelectorAll(":scope > button")).toHaveLength(3)
    expect(screen.getByTestId("chip-working")).toBeTruthy()
  })

  it("renders the breadcrumb (board › ancestors › ID + title) and the title block", async () => {
    const item = full("PLA-22", { title: "Postal-code validation", rootId: "PLA-12", parentId: "PLA-14", depth: 2 })
    getWorkItem.mockResolvedValue(detailOf(item))
    getWorkItemTree.mockResolvedValue({
      tree: {
        root: treeNode(full("PLA-12"), [
          treeNode(full("PLA-14", { parentId: "PLA-12", depth: 1 }), [treeNode(item)]),
        ]),
        totals: {},
        spendUsd: 0,
      },
    })
    renderTask("/todos/PLA-22", { fromBoard: "platform" })

    await waitFor(() => expect(screen.getByTestId("task-title").textContent).toContain("Postal-code validation"))
    expect((screen.getByTestId("task-crumb-board")).textContent).toContain("Platform")
    await waitFor(() => expect(screen.getByTestId("task-crumb-PLA-12")).toBeTruthy())
    expect(screen.getByTestId("task-crumb-PLA-14")).toBeTruthy()
    expect(getWorkItemTree).toHaveBeenCalledWith("PLA-12")
  })

  it("moves the key properties into header chips and folds the document behind Details", async () => {
    const item = full("PLA-12", {
      assignee: "mason",
      priority: 3,
      budgetUsd: 10,
      body: "A short **markdown** body",
      acceptance: "- [x] Works\n- [ ] Ships",
    })
    getWorkItemTree.mockResolvedValue({
      tree: {
        root: treeNode(item, [treeNode(full("PLA-13", { parentId: "PLA-12", depth: 1 }))]),
        totals: {},
        spendUsd: 0,
      },
    })
    listWorkItemAttachments.mockResolvedValue({
      attachments: [{
        id: "wia_1",
        workItemId: "PLA-12",
        commentId: null,
        filename: "proof.png",
        mime: "image/png",
        bytes: 10,
        sha256: "abc",
        storagePath: "/tmp/proof.png",
        uploadedBy: "operator",
        createdAt: "2026-07-20T09:00:00.000Z",
      }],
    })
    getWorkItem.mockResolvedValue({
      ...detailOf(item),
      spendUsd: 4.35,
      labels: [{ id: "lbl_1", name: "build", color: null, department: null, createdAt: "2026-07-01T00:00:00.000Z" }],
    })
    renderTask()

    const chips = await screen.findByTestId("task-chip-cluster")
    expect(chips.textContent).toContain("Executing")
    expect(chips.textContent).toContain("High")
    expect(chips.textContent).toContain("mason")
    expect(chips.textContent).toContain("build")

    const toggle = screen.getByTestId("task-details-toggle")
    const content = screen.getByTestId("task-details-content") as HTMLDivElement
    await waitFor(() =>
      expect(toggle.textContent).toContain("Acceptance 1/2 · 1 sub-task · 1 attachment · body 4 words"),
    )
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(content.hidden).toBe(true)
    expect(screen.getByTestId("task-props-rail")).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(content.hidden).toBe(false)
  })

  it("banner precedence: escalated wins over a pending approval", async () => {
    const item = full("PLA-12", {
      status: "escalated",
      approvalState: "pending",
      approvalRequest: "OK to go live?",
    })
    getWorkItem.mockResolvedValue(detailOf(item, {
      events: [{
        id: "e1", workItemId: "PLA-12", kind: "status_change", fromStatus: "in_review",
        toStatus: "escalated", actor: "reviewer", detail: { note: "Rounds exhausted, your call" },
        createdAt: "2026-07-23T07:00:00.000Z",
      }],
    }))
    renderTask()

    expect((await screen.findByTestId("task-banner-escalated")).textContent).toContain("Rounds exhausted, your call")
    expect(screen.queryByTestId("task-banner-approval")).toBeNull()
    expect(screen.queryByTestId("task-banner-blocked")).toBeNull()
  })

  it("approval banner decides through the approval surface", async () => {
    const item = full("PLA-12", { status: "in_review", approvalState: "pending", approvalRequest: "OK to go live?" })
    getWorkItem.mockResolvedValue(detailOf(item))
    decideWorkItemApproval.mockResolvedValue({ workItem: full("PLA-12", { status: "in_review" }), escalated: false })
    renderTask()

    const banner = await screen.findByTestId("task-banner-approval")
    expect((banner).textContent).toContain("OK to go live?")
    fireEvent.click(screen.getByTestId("task-banner-approve"))
    // No offered options on this gate → no choice argument.
    await waitFor(() => expect(decideWorkItemApproval).toHaveBeenCalledWith("PLA-12", "approve", undefined, undefined))
  })

  it("Reject… decides nothing on its own — the note and the decision submit together", async () => {
    const item = full("PLA-12", { status: "in_review", approvalState: "pending", approvalRequest: "OK to go live?" })
    getWorkItem.mockResolvedValue(detailOf(item))
    decideWorkItemApproval.mockResolvedValue({ workItem: item, escalated: false })
    renderTask()

    await screen.findByTestId("task-banner-approval")
    fireEvent.click(screen.getByTestId("task-banner-reject"))
    expect(decideWorkItemApproval).not.toHaveBeenCalled()

    const note = screen.getByTestId("task-banner-reject-note")
    fireEvent.change(note, { target: { value: "Cite the source first" } })
    // Leaving the field is not a decision, and it must not lose the words.
    fireEvent.blur(note)
    expect(decideWorkItemApproval).not.toHaveBeenCalled()
    expect(screen.getByTestId("task-banner-reject-consequence").textContent).toContain("another round")

    fireEvent.click(screen.getByTestId("task-banner-reject-confirm"))
    await waitFor(() =>
      expect(decideWorkItemApproval).toHaveBeenCalledWith("PLA-12", "reject", "Cite the source first", undefined),
    )
    expect(decideWorkItemApproval).toHaveBeenCalledTimes(1)
  })

  it("an empty rejection is submitted as the stop it is, and says so first", async () => {
    const item = full("PLA-12", { status: "in_review", approvalState: "pending", approvalRequest: "OK to go live?" })
    getWorkItem.mockResolvedValue(detailOf(item))
    decideWorkItemApproval.mockResolvedValue({ workItem: item, escalated: false })
    renderTask()

    await screen.findByTestId("task-banner-approval")
    fireEvent.click(screen.getByTestId("task-banner-reject"))
    expect(screen.getByTestId("task-banner-reject-consequence").textContent).toContain("Ends the work")
    fireEvent.click(screen.getByTestId("task-banner-reject-confirm"))
    await waitFor(() => expect(decideWorkItemApproval).toHaveBeenCalledWith("PLA-12", "reject", undefined, undefined))
  })

  it("a choice gate holds Approve until an option is picked, then sends the pick", async () => {
    const item = full("PLA-12", { status: "in_review", approvalState: "pending", approvalRequest: "Which variant ships?" })
    getWorkItem.mockResolvedValue(detailOf(item, {
      approvals: [{
        id: "wap_1", workItemId: "PLA-12", state: "pending", request: "Which variant ships?", ref: null,
        options: ["variant-a", "variant-b"], choice: null, target: null, targetKind: null,
        requestedBy: "workflow", requestedAt: "2026-07-23T07:00:00.000Z", escalatedAt: null,
        decidedBy: null, decidedAt: null, note: null,
      }],
    }))
    decideWorkItemApproval.mockResolvedValue({ workItem: item, escalated: false })
    renderTask()

    await screen.findByTestId("task-banner-approval")
    // Approving without a pick is structurally impossible, not merely refused.
    expect((screen.getByTestId("task-banner-approve") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: "variant-b" }))
    fireEvent.click(screen.getByTestId("task-banner-approve"))
    await waitFor(() => expect(decideWorkItemApproval).toHaveBeenCalledWith("PLA-12", "approve", undefined, "variant-b"))
  })

  it("a reason-less blocked item grows the banner reason field; Save PUTs the same status with the note (F6)", async () => {
    const item = full("PLA-12", { status: "blocked" })
    getWorkItem.mockResolvedValue(detailOf(item))
    setWorkItemStatus.mockResolvedValue({ workItem: item, escalated: false })
    renderTask("/todos/PLA-12", { focusBannerReason: true })

    const input = await screen.findByTestId("task-banner-reason")
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: "Waiting on vendor keys" } })
    fireEvent.click(screen.getByTestId("task-banner-reason-save"))
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-12", "blocked", "Waiting on vendor keys"))
  })

  it("an unfinished reason survives losing focus — only a submit commits it", async () => {
    const item = full("PLA-12", { status: "blocked" })
    getWorkItem.mockResolvedValue(detailOf(item))
    setWorkItemStatus.mockResolvedValue({ workItem: item, escalated: false })
    renderTask("/todos/PLA-12", { focusBannerReason: true })

    const input = await screen.findByTestId("task-banner-reason")
    fireEvent.change(input, { target: { value: "Waiting on ven" } })
    // Switching browser tabs blurs the focused field. That is not a decision.
    fireEvent.blur(input)
    expect(setWorkItemStatus).not.toHaveBeenCalled()
    expect((screen.getByTestId("task-banner-reason") as HTMLInputElement).value).toBe("Waiting on ven")
  })

  it("a blocked item WITH a reason renders it rail-quoted instead of the input", async () => {
    const item = full("PLA-12", { status: "blocked" })
    getWorkItem.mockResolvedValue(detailOf(item, {
      events: [{
        id: "e1", workItemId: "PLA-12", kind: "status_change", fromStatus: "executing",
        toStatus: "blocked", actor: "mason", detail: { note: "Waiting on vendor keys" },
        createdAt: "2026-07-23T07:00:00.000Z",
      }],
    }))
    renderTask()

    const banner = await screen.findByTestId("task-banner-blocked")
    expect((banner).textContent).toContain("Waiting on vendor keys")
    expect(screen.queryByTestId("task-banner-reason")).toBeNull()
  })

  it("rejects a malformed route identifier before any item lookup (isTodoId guard)", async () => {
    renderTask("/todos/not-a-todo")
    expect(await screen.findByText("That's not a Todo ID.")).toBeTruthy()
    expect(getWorkItem).not.toHaveBeenCalled()
  })

  it("unknown ids land on the not-found state, not a crash", async () => {
    getWorkItem.mockRejectedValue(Object.assign(new Error("nf"), { status: 404 }))
    renderTask("/todos/ZZZ-99")
    expect(await screen.findByText(/doesn't exist/)).toBeTruthy()
  })

  it("a transport failure shows a visible Retry — never the missing state — and resolves on retry (cutover migration)", async () => {
    getWorkItem.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { status: 502 }))
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12", { title: "Recovered title" })))
    renderTask()
    const error = await screen.findByTestId("task-load-error")
    expect(error.textContent).not.toContain("doesn't exist")
    fireEvent.click(screen.getByTestId("task-load-retry"))
    await waitFor(() => expect(screen.getByTestId("task-title").textContent).toContain("Recovered title"))
  })

  it("the body renders through MarkdownView when present and the quiet placeholder when empty", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12", { body: "Let a buyer **complete** a purchase." })))
    renderTask()
    const body = await screen.findByTestId("task-body")
    await waitFor(() => expect((body).textContent).toContain("complete"))
  })

  it("desktop keeps the tab bar; the in-flow composer is the one composer", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    await screen.findByTestId("task-chip-cluster")
    expect(screen.getByTestId("page-layout").dataset.hideMobileTabBar).toBe("false")
    expect(screen.getByTestId("task-composer")).toBeTruthy()
    expect(screen.queryByTestId("task-composer-mobile")).toBeNull()
  })

  it("mobile is a full-screen push (§8): the tab bar yields and the fixed comment bar owns the bottom edge", async () => {
    stubMobileViewport()
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    await screen.findByTestId("task-chip-cluster")
    expect(screen.getByTestId("page-layout").dataset.hideMobileTabBar).toBe("true")
    const bar = screen.getByTestId("task-composer-mobile")
    expect(bar).toBeTruthy()
    // Mock anatomy: paperclip · "+ Comment" capsule · send, in that order.
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).placeholder).toBe("Comment")
    expect(screen.getByTestId("composer-attach").getAttribute("aria-label")).toBe("Attach")
    expect(screen.getByTestId("composer-send").getAttribute("aria-label")).toBe("Send")
    expect(screen.queryByTestId("task-composer")).toBeNull()
  })
})
