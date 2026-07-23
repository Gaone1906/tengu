import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { InstanceMigrationGate } from "../instance-migration-gate"
import type { InstanceMigration } from "@/lib/api"

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
  render(<QueryClientProvider client={client}><InstanceMigrationGate service={service} navigate={navigate} /></QueryClientProvider>)
  return { client, service, navigate }
}

describe("InstanceMigrationGate", () => {
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
    expect(dialog.innerHTML).toContain("var(--bg)")
    expect(dialog.innerHTML).not.toContain("var(--background)")
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByRole("button", { name: /Finish v0\.26\.0 setup/ })).not.toBeNull()
  })
})
