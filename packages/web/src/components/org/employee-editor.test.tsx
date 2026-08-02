import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Employee } from "@/lib/api"

// ModelSelectorRow has its own tests + needs the model registry; stub it here so
// this test focuses on the editor's own behavior (validation, diffing, save).
vi.mock("@/components/chat/model-selector-row", () => ({
  ModelSelectorRow: ({ value, onChange }: {
    value: { engine: string; model?: string; effortLevel?: string }
    onChange: (next: { engine: string; model?: string; effortLevel?: string }) => void
  }) => (
    <button
      type="button"
      data-testid="model-selector"
      onClick={() => onChange({ ...value, model: "gpt-5.5", effortLevel: "medium" })}
    >
      Change runtime
    </button>
  ),
}))

const updateEmployee = vi.fn()
const getOrg = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    updateEmployee: (...a: unknown[]) => updateEmployee(...a),
    getOrg: (...a: unknown[]) => getOrg(...a),
  },
}))

import { EmployeeEditor } from "./employee-editor"

const EMP: Employee = {
  name: "content-writer",
  displayName: "Content Writer",
  department: "content",
  rank: "employee",
  engine: "claude",
  model: "sonnet",
  persona: "You write blog posts.",
}

const saveBtn = () => screen.getByRole("button", { name: /^(Save|Saving)/ }) as HTMLButtonElement

beforeEach(() => {
  updateEmployee.mockReset()
  getOrg.mockReset()
  getOrg.mockResolvedValue({ departments: ["content"], employees: [{ name: "content-lead" }] })
})

describe("EmployeeEditor", () => {
  it("disables Save when pristine and when persona is emptied", () => {
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)
    expect(saveBtn().disabled).toBe(true) // pristine

    const persona = screen.getByDisplayValue("You write blog posts.")
    fireEvent.change(persona, { target: { value: "   " } })
    expect(saveBtn().disabled).toBe(true)
    expect(screen.getByText("Persona cannot be empty.")).toBeTruthy()
  })

  it("sends only the changed fields and calls onSaved on success", async () => {
    const onSaved = vi.fn()
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, persona: "New persona." } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByDisplayValue("You write blog posts."), { target: { value: "New persona." } })
    expect(saveBtn().disabled).toBe(false)
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1))
    expect(updateEmployee).toHaveBeenCalledWith("content-writer", { persona: "New persona." })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...EMP, persona: "New persona." }))
  })

  it("keeps the form open and shows the error on a failed save", async () => {
    const onSaved = vi.fn()
    updateEmployee.mockRejectedValue(new Error("rank must be one of ..."))
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByDisplayValue("You write blog posts."), { target: { value: "Changed." } })
    fireEvent.click(saveBtn())

    await waitFor(() => expect(screen.getByText("rank must be one of ...")).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
    expect(saveBtn()).toBeTruthy() // still open
  })

  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn()
    render(<EmployeeEditor employee={EMP} onCancel={onCancel} onSaved={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("locks system identity fields while keeping runtime knobs editable", async () => {
    const systemEmployee: Employee = {
      ...EMP,
      name: "todo-dispatcher",
      displayName: "Todo Dispatcher",
      department: "system",
      rank: "senior",
      engine: "codex",
      model: "gpt-5.6-sol",
      effortLevel: "high",
      persona: "Choose the best employee and hand the Todo off.",
      cliFlags: ["--system-flag"],
      reportsTo: "operations-lead",
      system: true,
    }
    updateEmployee.mockResolvedValue({
      status: "ok",
      employee: { ...systemEmployee, model: "gpt-5.5", effortLevel: "medium" },
    })

    render(<EmployeeEditor employee={systemEmployee} onCancel={() => {}} onSaved={() => {}} />)

    expect(screen.getByText("System")).toBeTruthy()
    expect(screen.getByTestId("system-readonly-rank").textContent).toBe("Senior")
    expect(screen.getByTestId("system-readonly-department").textContent).toBe("system")
    expect(screen.getByTestId("system-readonly-persona").textContent).toContain("Choose the best employee")
    expect(screen.queryByDisplayValue("Choose the best employee and hand the Todo off.")).toBeNull()
    expect(screen.queryByDisplayValue("--system-flag")).toBeNull()

    fireEvent.click(screen.getByTestId("model-selector"))
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("todo-dispatcher", {
      model: "gpt-5.5",
      effortLevel: "medium",
    }))
  })
})
