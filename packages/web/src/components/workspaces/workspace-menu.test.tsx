import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { WorkspaceLauncher, type WorkspaceInfo } from "./workspace-menu"

const workspaces: WorkspaceInfo[] = [
  { id: "main", name: "jinn", displayName: "Main company", port: 7777, running: true, current: true, switchUrl: "https://machine.example.ts.net/" },
  { id: "team", name: "jinn-team", displayName: "Team company", port: 7801, running: true, current: false, switchUrl: "https://machine.example.ts.net:7801/" },
  { id: "offline", name: "jinn-offline", displayName: "Offline company", port: 7802, running: false, current: false, switchUrl: "https://machine.example.ts.net:7802/" },
]

function open() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /switch workspace/i }), { button: 0, ctrlKey: false })
}

/** Reveal the collapsed offline section. */
function expandOffline() {
  fireEvent.click(screen.getByRole("menuitem", { name: /\d+ offline/i }))
}

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
    expandOffline()
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

    open()

    expect(await screen.findByText("Main company")).toBeTruthy()
    expandOffline()
    expect(screen.getByText("Offline company")).toBeTruthy()
    expect(screen.getAllByText("Offline")).toHaveLength(1)
  })

  /**
   * The registry accumulates every sandbox ever created (32 rows on the
   * operator's machine, 3 of them actually running), so an unfiltered list
   * buried the workspaces you can switch to under ~29 dead ones. Offline rows
   * now sit behind a disclosure; online/current ones are never hidden.
   */
  describe("offline workspaces", () => {
    it("hides offline workspaces behind a disclosure by default", async () => {
      render(<WorkspaceLauncher workspaces={workspaces} onAdd={vi.fn()} onStart={vi.fn()} />)
      open()

      expect(await screen.findByText("Main company")).toBeTruthy()
      expect(screen.queryByText("Offline company")).toBeNull()
      expect(screen.getByRole("menuitem", { name: /1 offline/i })).toBeTruthy()
    })

    it("never hides the current or running workspaces", async () => {
      render(<WorkspaceLauncher workspaces={workspaces} onAdd={vi.fn()} onStart={vi.fn()} />)
      open()

      expect(await screen.findByText("Main company")).toBeTruthy()
      expect(screen.getByText("Team company")).toBeTruthy()
      expect(document.querySelector('a[aria-label="Open Team company"]')).toBeTruthy()
    })

    it("expands to reveal offline rows and keeps the menu open", async () => {
      const onStart = vi.fn()
      render(<WorkspaceLauncher workspaces={workspaces} onAdd={vi.fn()} onStart={onStart} />)
      open()
      await screen.findByText("Main company")

      expandOffline()

      // preventDefault on select is what keeps the menu mounted; without it
      // Radix closes the dropdown and every assertion below fails.
      expect(screen.getByText("Main company")).toBeTruthy()
      expect(screen.getByText("Offline company")).toBeTruthy()
      fireEvent.click(screen.getByRole("menuitem", { name: /start offline company/i }))
      expect(onStart).toHaveBeenCalledWith(workspaces[2])
      expect(screen.getByRole("menuitem", { name: /hide offline/i })).toBeTruthy()
    })

    it("shows no disclosure when every workspace is online", async () => {
      const allOnline = workspaces.filter((workspace) => workspace.running)
      render(<WorkspaceLauncher workspaces={allOnline} onAdd={vi.fn()} onStart={vi.fn()} />)
      open()

      expect(await screen.findByText("Main company")).toBeTruthy()
      expect(screen.queryByText(/offline/i)).toBeNull()
    })

    it("keeps a starting workspace visible while the section is collapsed", async () => {
      render(<WorkspaceLauncher workspaces={workspaces} onAdd={vi.fn()} onStart={vi.fn()} startingId="offline" />)
      open()

      // Its row must not vanish mid-start just because it is not running yet.
      expect(await screen.findByText("Offline company")).toBeTruthy()
      expect(screen.getByText("Starting…")).toBeTruthy()
      expect(screen.queryByRole("menuitem", { name: /\d+ offline/i })).toBeNull()
    })

    it("keeps a workspace that failed to start visible, with its error", async () => {
      render(
        <WorkspaceLauncher
          workspaces={workspaces}
          onAdd={vi.fn()}
          onStart={vi.fn()}
          startError={{ id: "offline", message: "Port already in use" }}
        />,
      )
      open()

      expect(await screen.findByText("Offline company")).toBeTruthy()
      expect(screen.getByText("Port already in use")).toBeTruthy()
    })
  })
})
