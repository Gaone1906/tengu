import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { WorkspaceLauncher, type WorkspaceInfo } from "./workspace-menu"

const workspaces: WorkspaceInfo[] = [
  { id: "main", name: "jinn", displayName: "Main company", port: 7777, running: true, current: true, switchUrl: "https://machine.example.ts.net/" },
  { id: "team", name: "jinn-team", displayName: "Team company", port: 7801, running: true, current: false, switchUrl: "https://machine.example.ts.net:7801/" },
  { id: "offline", name: "jinn-offline", displayName: "Offline company", port: 7802, running: false, current: false, switchUrl: "https://machine.example.ts.net:7802/" },
]

describe("WorkspaceLauncher", () => {
  it("uses one neutral icon and opens a full-name workspace menu with real links", async () => {
    const onAdd = vi.fn()
    const onStart = vi.fn()
    render(<WorkspaceLauncher workspaces={workspaces} onAdd={onAdd} onStart={onStart} />)

    const trigger = screen.getByRole("button", { name: /switch workspace/i })
    expect(trigger.querySelectorAll("svg")).toHaveLength(1)
    expect(trigger.getAttribute("class")).not.toMatch(/system-(blue|green|orange)|accent-fill/)
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })

    expect(await screen.findByText("Main company")).toBeTruthy()
    expect(document.querySelector('a[aria-label="Open Team company"]')?.getAttribute("href")).toBe("https://machine.example.ts.net:7801/")
    expect(document.querySelector('a[aria-label="Open Offline company"]')).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: /start offline company/i }))
    expect(onStart).toHaveBeenCalledWith(workspaces[2])
    fireEvent.click(screen.getByRole("menuitem", { name: /add workspace/i }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  // A gateway older than the launcher serves /api/instances rows without `id`.
  // `startError?.id === workspace.id` then compared undefined to undefined and
  // read `.message` off a null startError, blanking the whole page.
  it("renders workspaces served without ids instead of crashing", async () => {
    const legacy = workspaces.map(({ id: _id, ...rest }) => rest) as WorkspaceInfo[]
    render(<WorkspaceLauncher workspaces={legacy} onAdd={vi.fn()} onStart={vi.fn()} startError={null} />)

    fireEvent.pointerDown(screen.getByRole("button", { name: /switch workspace/i }), { button: 0, ctrlKey: false })

    expect(await screen.findByText("Main company")).toBeTruthy()
    expect(screen.getByText("Offline company")).toBeTruthy()
    expect(screen.getAllByText("Offline")).toHaveLength(1)
  })
})
