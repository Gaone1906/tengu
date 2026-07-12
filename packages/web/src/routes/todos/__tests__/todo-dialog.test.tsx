import { useState } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { TodoDialog } from "../todo-dialog"

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open details</button>
      {open && (
        <TodoDialog label="Todo details" onRequestClose={() => setOpen(false)}>
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </TodoDialog>
      )}
    </>
  )
}

describe("TodoDialog focus scope", () => {
  it("traps focus, closes on Escape, and restores focus to the opener", async () => {
    render(<Harness />)
    const opener = screen.getByRole("button", { name: "Open details" })
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole("dialog", { name: "Todo details" })
    const first = screen.getByRole("button", { name: "First action" })
    await waitFor(() => expect(document.activeElement).toBe(dialog))

    const last = screen.getByRole("button", { name: "Last action" })
    last.focus()
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(document.activeElement).toBe(opener)
  })
})
