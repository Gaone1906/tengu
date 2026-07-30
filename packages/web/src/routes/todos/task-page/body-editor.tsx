import { lazy, Suspense, useState } from "react"
import { MarkdownView } from "@/components/markdown-view"
import { BODY_PLACEHOLDER } from "./body-editor-constants"

const LiveBodyEditor = lazy(async () => {
  const module = await import("./live-body-editor")
  return { default: module.LiveBodyEditor }
})

export { BODY_PLACEHOLDER }

export function BodyEditor({
  body,
  editable,
  isDark,
  onCommit,
  editorRef,
}: {
  body: string | null
  editable: boolean
  isDark: boolean
  onCommit: (markdown: string) => void
  editorRef?: React.MutableRefObject<unknown | null>
}) {
  const [editing, setEditing] = useState(false)
  const readView = body ? (
    <MarkdownView content={body} isDark={isDark} />
  ) : (
    <p className="text-[16px] leading-[1.6] text-[var(--text-quaternary)]">{BODY_PLACEHOLDER}</p>
  )

  if (!editable) return readView

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        data-testid="task-body-read"
        aria-label="Edit description"
        className="w-full cursor-text text-left outline-none"
        onClick={() => setEditing(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") setEditing(true)
        }}
      >
        {readView}
      </div>
    )
  }

  return (
    <Suspense fallback={<div data-testid="task-body-loading">{readView}</div>}>
      <LiveBodyEditor
        body={body}
        onCommit={onCommit}
        editorRef={editorRef}
        onExit={() => setEditing(false)}
      />
    </Suspense>
  )
}
