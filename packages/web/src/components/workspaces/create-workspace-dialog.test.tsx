import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"

describe("CreateWorkspaceDialog", () => {
  it("creates a workspace and navigates to its paired onboarding URL", async () => {
    const create = vi.fn(async () => ({
      instance: { id: "john", name: "jinn-john", displayName: "John", port: 7788, running: true, current: false, switchUrl: "https://machine.example.ts.net:7788/" },
      launchUrl: "https://machine.example.ts.net:7788/?onboarding=1#jinn-pair=ABCD-EFGH-JKLM",
    }))
    const navigate = vi.fn()
    render(<CreateWorkspaceDialog open onOpenChange={() => {}} create={create} navigate={navigate} />)

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "John" } })
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }))

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "John" }))
    expect(navigate).toHaveBeenCalledWith("https://machine.example.ts.net:7788/?onboarding=1#jinn-pair=ABCD-EFGH-JKLM")
  })

  it("keeps API errors inline and does not navigate", async () => {
    const create = vi.fn(async () => { throw new Error("Workspace already exists") })
    const navigate = vi.fn()
    render(<CreateWorkspaceDialog open onOpenChange={() => {}} create={create} navigate={navigate} />)

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "John" } })
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }))

    expect((await screen.findByRole("alert")).textContent).toContain("Workspace already exists")
    expect(navigate).not.toHaveBeenCalled()
  })
})
