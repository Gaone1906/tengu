import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TodoQuickEditRetryActions } from "../quick-edit-retry-actions"

describe("TodoQuickEditRetryActions", () => {
  it("offers keyboard-safe retry and discard actions without exposing diagnostics", async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onDiscard = vi.fn()
    const focusRef = createRef<HTMLElement>()
    render(
      <TodoQuickEditRetryActions
        busy={false}
        error="The connection is unavailable. Your local edit is still saved."
        focusRef={focusRef}
        onRetry={onRetry}
        onDiscard={onDiscard}
      />,
    )

    const surface = screen.getByRole("status", { name: "Todo edit needs attention" })
    expect(focusRef.current).toBe(surface)
    expect(surface.textContent).not.toMatch(/wi_|\/private\/|stack|token/i)
    const retry = screen.getByRole("button", { name: "Retry save" })
    const discard = screen.getByRole("button", { name: "Discard local edit" })
    expect(retry.className).toContain("min-h-11")
    expect(discard.className).toContain("min-h-11")

    await user.tab()
    expect(document.activeElement).toBe(retry)
    await user.keyboard("{Enter}")
    expect(onRetry).toHaveBeenCalledTimes(1)
    await user.tab()
    await user.keyboard(" ")
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it("keeps both actions inert while a retry is in flight", async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onDiscard = vi.fn()
    render(
      <TodoQuickEditRetryActions
        busy
        error={null}
        onRetry={onRetry}
        onDiscard={onDiscard}
      />,
    )

    expect(screen.getByRole("button", { name: "Retrying save" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "Discard local edit" }).hasAttribute("disabled")).toBe(true)
    await user.click(screen.getByRole("button", { name: "Retrying save" }))
    expect(onRetry).not.toHaveBeenCalled()
    expect(onDiscard).not.toHaveBeenCalled()
  })
})
