import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Employee } from "@/lib/api"
import { NewTodoDialog } from "../new-todo-dialog"

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const createWorkItem = vi.fn()
const assignWorkItem = vi.fn()
const listLabels = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      createWorkItem: (...args: unknown[]) => createWorkItem(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      listLabels: (...args: unknown[]) => listLabels(...args),
    },
  }
})

const employees: Employee[] = [
  { name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
]
const departments = [
  { slug: "platform", prefix: "PLA", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 },
  { slug: "operations", prefix: "OPS", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 3 },
]

function renderDialog(overrides: { onCreated?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onCreated = vi.fn(overrides.onCreated)
  render(
    <QueryClientProvider client={client}>
      <NewTodoDialog
        onClose={vi.fn()}
        onCreated={onCreated}
        defaults={{ employees, departments, department: "platform" }}
      />
    </QueryClientProvider>,
  )
  return { onCreated }
}

beforeEach(() => {
  vi.clearAllMocks()
  createWorkItem.mockResolvedValue({ workItem: { id: "PLA-9" } })
  assignWorkItem.mockResolvedValue({ workItem: { id: "PLA-9" } })
  listLabels.mockResolvedValue({ labels: [
    { id: "lab_1", name: "release", color: "#5B9BD5", department: null, createdAt: "2026-07-01T00:00:00.000Z" },
  ] })
})

describe("NewTodoDialog", () => {
  it("gives every property chip at least a 34px tap target", () => {
    renderDialog()

    for (const chip of screen.getAllByTestId(/^todo-new-.*-chip$/)) {
      expect(chip.classList.contains("min-h-9")).toBe(true)
    }
  })

  it("creates once with the rich payload, then assigns through the legal edge", async () => {
    const user = userEvent.setup()
    const { onCreated } = renderDialog()

    await user.type(screen.getByTestId("todo-new-title"), "Ship the ledger")
    await user.type(screen.getByTestId("todo-new-description"), "Keep the board intact.")

    await user.click(screen.getByTestId("todo-new-department-chip"))
    await user.click(screen.getByTestId("department-option-operations"))
    await user.click(screen.getByTestId("todo-new-priority-chip"))
    await user.click(screen.getByTestId("priority-option-3"))
    await user.click(screen.getByTestId("todo-new-due-chip"))
    await user.click(screen.getByTestId("due-day-12"))
    await user.click(screen.getByTestId("todo-new-labels-chip"))
    await user.click(await screen.findByTestId("label-option-lab_1"))
    await user.click(screen.getByTestId("todo-new-parent-chip"))
    await user.type(screen.getByTestId("todo-new-parent"), "OPS-2")
    await user.click(screen.getByTestId("todo-new-acceptance-chip"))
    await user.type(screen.getByTestId("todo-new-acceptance"), "List and board both work.")
    await user.click(screen.getByTestId("todo-new-assignee-chip"))
    await user.click(screen.getByTestId("assignee-option-mason"))
    await user.click(screen.getByTestId("todo-new-create"))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(createWorkItem).toHaveBeenCalledTimes(1)
    expect(createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      title: "Ship the ledger",
      body: "Keep the board intact.",
      acceptance: "List and board both work.",
      department: "operations",
      priority: 3,
      dueAt: expect.stringMatching(/T12:00:00\.000Z$/),
      parentId: "OPS-2",
      labels: ["lab_1"],
    }))
    expect(assignWorkItem).toHaveBeenCalledWith("PLA-9", "mason")
    expect(createWorkItem.mock.invocationCallOrder[0]).toBeLessThan(assignWorkItem.mock.invocationCallOrder[0])
  })

  it("creates more, clears the form and returns focus to the title", async () => {
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    const title = screen.getByTestId("todo-new-title")
    await user.type(title, "First task")
    await user.click(screen.getByTestId("todo-new-create-more"))

    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    expect(onCreated).not.toHaveBeenCalled()
    expect((title as HTMLInputElement).value).toBe("")
    await waitFor(() => expect(document.activeElement).toBe(title))
    expect(screen.getByRole("dialog", { name: "New todo" })).not.toBeNull()
  })

  it("uses command-enter to create and close", async () => {
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    const title = screen.getByTestId("todo-new-title")
    await user.type(title, "Keyboard task")
    await user.keyboard("{Meta>}{Enter}{/Meta}")
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
  })
})
