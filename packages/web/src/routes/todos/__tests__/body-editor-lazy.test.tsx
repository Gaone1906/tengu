import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { BodyEditor } from "../task-page/body-editor"

describe("the Todo body editor lazy boundary", () => {
  it("renders markdown first, then loads and focuses the editor before preserving its commit", async () => {
    const onCommit = vi.fn()
    const editorRef: { current: unknown | null } = { current: null }

    render(
      <BodyEditor
        body={"## Scope\n\nOriginal."}
        editable
        isDark
        onCommit={onCommit}
        editorRef={editorRef}
      />,
    )

    const readView = screen.getByTestId("task-body-read")
    expect(readView.querySelector("h2")?.textContent).toBe("Scope")
    expect(document.querySelector("[contenteditable=true]")).toBeNull()

    fireEvent.click(readView)

    const prose = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".ProseMirror[contenteditable=true]")
      if (!element || !editorRef.current) throw new Error("editor has not loaded")
      return element
    })
    await waitFor(() => expect(document.activeElement).toBe(prose))

    ;(editorRef.current as { commands: { setContent: (content: string) => void } }).commands.setContent(
      "## Scope\n\nRewritten.",
    )
    fireEvent.blur(prose)

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    expect(onCommit.mock.calls[0][0]).toContain("Rewritten.")
  })
})
