import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { InstanceMigrationGate } from "../instance-migration-gate"
import { ApiError, type InstanceMigration } from "@/lib/api"

const dismissedStorageKey = "jinn.instance-migration.dismissed-key"

const pending: InstanceMigration = {
  required: true,
  fromVersion: "0.25.0",
  toVersion: "0.26.0",
  versions: ["0.26.0"],
  changedFiles: [{ path: "CLAUDE.md", operation: "modify" }],
  prompt: "canonical prompt\n",
  migrationKey: "key-1",
}

function setup(overrides: Partial<{
  get: () => Promise<InstanceMigration>
  open: (key: string) => Promise<{ sessionId: string; reused: boolean; migrationKey: string }>
  navigate: (url: string) => void
}> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const service = {
    get: overrides.get ?? vi.fn().mockResolvedValue(pending),
    open: overrides.open ?? vi.fn().mockResolvedValue({ sessionId: "session one", reused: false, migrationKey: "key-1" }),
  }
  const navigate = overrides.navigate ?? vi.fn()
  const view = render(<QueryClientProvider client={client}><InstanceMigrationGate service={service} navigate={navigate} /></QueryClientProvider>)
  return { client, service, navigate, view }
}

describe("InstanceMigrationGate", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("renders nothing when the instance is current", async () => {
    setup({ get: vi.fn().mockResolvedValue({ ...pending, required: false, prompt: null, migrationKey: null }) })
    await waitFor(() => expect(screen.queryByText(/Finish v0\.26\.0 setup/)).toBeNull())
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("opens automatically; Later hides the reminder for the current migration", async () => {
    const nextMigration = { ...pending, toVersion: "0.27.0", versions: ["0.27.0"], migrationKey: "key-2" }
    const get = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(nextMigration)
    const { client } = setup({ get })
    expect(await screen.findByRole("dialog", { name: /v0\.26\.0 is installed/ })).not.toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Later" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByRole("button", { name: /Finish v0\.26\.0 setup/ })).toBeNull()

    await client.refetchQueries({ queryKey: ["instance-migration"] })
    expect(screen.queryByRole("button", { name: /Finish v0\.26\.0 setup/ })).toBeNull()

    await client.refetchQueries({ queryKey: ["instance-migration"] })
    expect(await screen.findByRole("dialog", { name: /v0\.27\.0 is installed/ })).not.toBeNull()
  })

  it("keeps Later acknowledged across a full page remount but presents a new migration key", async () => {
    const get = vi.fn().mockResolvedValue(pending)
    const first = setup({ get })
    await screen.findByRole("dialog")
    await userEvent.click(screen.getByRole("button", { name: "Later" }))
    expect(window.localStorage.getItem(dismissedStorageKey)).toBe("key-1")
    first.view.unmount()

    const second = setup({ get })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByRole("button", { name: /Finish v0\.26\.0 setup/ })).toBeNull()
    second.view.unmount()

    setup({ get: vi.fn().mockResolvedValue({ ...pending, toVersion: "0.27.0", migrationKey: "key-2" }) })
    expect(await screen.findByRole("dialog", { name: /v0\.27\.0 is installed/ })).not.toBeNull()
  })

  it.each(["Copy migration prompt", "Open with COO"])(
    "persists acknowledgement after the %s action",
    async (action) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
      })
      setup()
      await screen.findByRole("dialog")
      await userEvent.click(screen.getByRole("button", { name: action }))
      await waitFor(() => expect(window.localStorage.getItem(dismissedStorageKey)).toBe("key-1"))
    },
  )

  it("copies exact prompt and opens one encoded COO session", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const { service, navigate } = setup()
    await screen.findByRole("dialog")
    await userEvent.click(screen.getByRole("button", { name: "Copy migration prompt" }))
    expect(writeText).toHaveBeenCalledWith("canonical prompt\n")
    expect(screen.getByRole("status").textContent).toContain("Migration prompt copied")
    const open = screen.getByRole("button", { name: "Open with COO" })
    await userEvent.dblClick(open)
    await waitFor(() => expect(service.open).toHaveBeenCalledTimes(1))
    expect(service.open).toHaveBeenCalledWith("key-1")
    expect(navigate).toHaveBeenCalledWith("/?session=session%20one")
  })

  it("keeps stale reminder visible on transient failure and retries", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(pending)
    const { client } = setup({ get })
    await screen.findByRole("dialog")
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await client.refetchQueries({ queryKey: ["instance-migration"] })
    expect(screen.getByRole("button", { name: /Finish v0\.26\.0 setup/ })).not.toBeNull()
    const retry = await screen.findByRole("button", { name: "Retry migration check" })
    const callsBeforeRetry = get.mock.calls.length
    await userEvent.click(retry)
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBeforeRetry))
  })

  it("renders an accessible retry state after an initial failure, then opens when retry succeeds", async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(pending)
    setup({ get })

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/temporarily unavailable/i)
    await userEvent.click(screen.getByRole("button", { name: "Retry migration check" }))

    expect(await screen.findByRole("dialog", { name: /v0\.26\.0 is installed/ })).not.toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Later" }))
    expect(screen.queryByRole("button", { name: /Finish v0\.26\.0 setup/ })).toBeNull()
  })

  it("removes banner and dialog after invalidation reports completion", async () => {
    const get = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue({ ...pending, required: false, prompt: null, migrationKey: null })
    const { client } = setup({ get })
    await screen.findByRole("dialog")
    await client.invalidateQueries({ queryKey: ["instance-migration"] })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("button", { name: /Finish/ })).toBeNull()
  })

  it("allows Escape and exposes reduced-motion/mobile-safe classes", async () => {
    setup()
    const dialog = await screen.findByRole("dialog")
    expect(dialog.className).toContain("max-w")
    expect(dialog.className).toContain("motion-reduce")
    expect(dialog.innerHTML).toContain("var(--bg-secondary)")
    expect(dialog.innerHTML).not.toContain("var(--background)")
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByRole("button", { name: /Finish v0\.26\.0 setup/ })).not.toBeNull()
  })

  it("keeps the reminder pill above the mobile tab bar + safe area (no bottom-tab collision)", async () => {
    setup()
    // Escape un-inerts the banner from the modal's aria-hidden subtree without dismissing it.
    await screen.findByRole("dialog")
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    const wrapper = screen.getByRole("button", { name: /Finish v0\.26\.0 setup/ }).closest("div.fixed")
    expect(wrapper).not.toBeNull()
    // Mobile bottom reserves the 49px tab bar + safe-area inset (the tab bar is
    // lg:hidden, so it occupies the bottom on every width below lg) — not the old
    // bottom-3 that parked the pill under the bar.
    expect(wrapper!.className).toContain("49px")
    expect(wrapper!.className).toContain("var(--safe-bottom)")
    expect(wrapper!.className).not.toContain("bottom-3")
    // Desktop (lg: the tab bar is gone) drops back to the resting bottom-5.
    expect(wrapper!.className).toContain("lg:bottom-5")
    expect(wrapper!.className).not.toContain("sm:bottom-5")
  })

  it("keeps the initial-service-error alert above the mobile tab bar + safe area", async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValue(new Error("offline"))
    setup({ get })
    const alert = await screen.findByRole("alert")
    const wrapper = alert.closest("div.fixed")
    expect(wrapper).not.toBeNull()
    expect(wrapper!.className).toContain("49px")
    expect(wrapper!.className).toContain("var(--safe-bottom)")
    expect(wrapper!.className).not.toContain("bottom-3")
    expect(wrapper!.className).toContain("lg:bottom-5")
    expect(wrapper!.className).not.toContain("sm:bottom-5")
  })

  it("focuses the informational title on open, not the Later dismiss action, and keeps Later keyboard-reachable", async () => {
    setup()
    const dialog = await screen.findByRole("dialog")
    const title = screen.getByRole("heading", { name: /v0\.26\.0 is installed/ })
    const later = screen.getByRole("button", { name: "Later" })

    // Radix default auto-focuses the first tabbable (Later), which lights the loud
    // amber focus ring on the quiet dismiss action. We intentionally focus the
    // informational title instead so no action carries a focus ring at rest.
    await waitFor(() => expect(document.activeElement).toBe(title))
    expect(document.activeElement).not.toBe(later)

    // The title receives focus only as an informational anchor — programmatic, via
    // tabIndex -1, and never part of the Tab sequence.
    expect(title.getAttribute("tabindex")).toBe("-1")

    // Later stays a real, enabled control in the tab order (focus was redirected,
    // not suppressed): Tab from the title moves keyboard focus onto it.
    expect(later.hasAttribute("disabled")).toBe(false)
    expect(later.getAttribute("tabindex")).not.toBe("-1")
    await userEvent.tab()
    expect(document.activeElement).toBe(later)
  })

  it("renders the Quiet Notice family: calm neutral material, amber only on the primary action, no purple gradient", async () => {
    setup()
    const dialog = await screen.findByRole("dialog")

    // Calm neutral Ledger material replaces the retired purple→blue gradient
    expect(dialog.innerHTML).toContain("var(--bg-secondary)")
    expect(dialog.innerHTML).not.toContain("linear-gradient")
    expect(dialog.innerHTML).not.toContain("var(--system-purple)")
    expect(dialog.innerHTML).not.toContain("var(--system-blue)")

    // Amber (accent) is spent ONLY on the primary "Open with COO" action
    const open = screen.getByRole("button", { name: "Open with COO" })
    expect(open.outerHTML).toContain("var(--accent)")
    const copy = screen.getByRole("button", { name: "Copy migration prompt" })
    expect(copy.outerHTML).not.toContain("var(--accent)")

    // Escape closes the dialog but keeps the reminder (no dismissal), exposing
    // the banner to the accessibility tree that the modal otherwise inerts.
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    // Banner is one quiet pill in the same family: a Finish action, no loud
    // "Action" badge and no gradient treatment.
    const banner = screen.getByRole("button", { name: /Finish v0\.26\.0 setup/ })
    expect(banner.outerHTML).not.toContain("linear-gradient")
    expect(banner.outerHTML).not.toContain("var(--system-purple)")
    expect(banner.outerHTML).not.toContain("var(--system-blue)")
    expect(banner.textContent).not.toContain("Action")
  })
})

describe("InstanceMigrationGate: actionable open failures", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("shows the server's remedy instead of the generic unavailable message", async () => {
    // A refused symlink is a local, fixable condition. "Temporarily unavailable"
    // reads as "wait and retry" for something that never clears on its own.
    const remedy = "Creating the migration snapshot needs symlink permission. On Windows, enable Developer Mode (Settings > System > For developers) or run the gateway elevated, then restart Jinn and retry."
    const open = vi.fn().mockRejectedValue(
      new ApiError(500, "Could not create the migration snapshot and COO handoff", "MIGRATION_OPEN_FAILED", undefined, remedy),
    )
    setup({ open })

    await userEvent.click(await screen.findByRole("button", { name: /open with coo/i }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Developer Mode")
    expect(alert.textContent).not.toMatch(/temporarily unavailable/i)
  })

  it("falls back to the generic message when the server offers no remedy", async () => {
    const open = vi.fn().mockRejectedValue(
      new ApiError(500, "Could not create the migration snapshot and COO handoff", "MIGRATION_OPEN_FAILED"),
    )
    setup({ open })

    await userEvent.click(await screen.findByRole("button", { name: /open with coo/i }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/temporarily unavailable/i)
  })
})
