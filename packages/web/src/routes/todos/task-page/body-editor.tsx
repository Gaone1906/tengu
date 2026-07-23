import { useEffect, useRef } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { Markdown } from "tiptap-markdown"
import { MarkdownView } from "@/components/markdown-view"

/* Todos v2 slice 6 — the live-markdown body (design-doc §7.4, operator redline
 * round 2): a Linear-style live editor, NO raw/preview toggle. Typing `## ` at
 * line start converts to a heading as you type, `- ` starts a list, backtick
 * pairs become code spans, ``` opens a code block — TipTap's input rules with
 * tiptap-markdown serialization, so the STORED body stays plain markdown and
 * agents read/write it over MCP unchanged (the editor is a view, never a
 * storage format). Library decision recorded in the stage report: TipTap
 * (ProseMirror) per the design doc's own recommendation — @tiptap/react 2.27
 * carries React 19 support and tiptap-markdown round-trips the text column.
 *
 * States: empty → quiet placeholder; reading (non-editors) → plain rendered
 * markdown via the shared MarkdownView, no hover wash; editing → rendered
 * grammar with a caret, hover wash on the block container only. Commit on
 * blur; the page's PATCH lane owns optimism + refusal snapback. */

const EDITOR_PROSE_CLASS = [
  "outline-none min-h-[24px] text-[16px] leading-[1.6] text-[var(--text-secondary)]",
  // MarkdownView-typography for the live blocks (mock task-detail.html .body-text).
  "[&_h1]:mt-[18px] [&_h1]:mb-1.5 [&_h1]:text-[22px] [&_h1]:font-bold [&_h1]:tracking-[-0.3px] [&_h1]:text-[var(--text-primary)]",
  "[&_h2]:mt-[18px] [&_h2]:mb-1.5 [&_h2]:text-[19px] [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)]",
  "[&_h3]:mt-[18px] [&_h3]:mb-1.5 [&_h3]:text-[18px] [&_h3]:font-semibold [&_h3]:tracking-[-0.24px] [&_h3]:text-[var(--text-primary)]",
  "[&_p+p]:mt-2.5",
  "[&_ul]:pl-1 [&_ul]:list-none [&_ol]:pl-5",
  "[&_ul>li]:relative [&_ul>li]:pl-[18px] [&_ul>li]:my-1",
  "[&_ul>li::before]:content-[''] [&_ul>li::before]:absolute [&_ul>li::before]:left-0.5 [&_ul>li::before]:top-[0.62em] [&_ul>li::before]:size-[5px] [&_ul>li::before]:rounded-full [&_ul>li::before]:bg-[var(--text-quaternary)]",
  "[&_code]:rounded-md [&_code]:bg-[var(--fill-tertiary)] [&_code]:px-1.5 [&_code]:py-px [&_code]:text-[13.5px] [&_code]:text-[var(--text-primary)] [&_code]:font-[var(--font-code)]",
  "[&_pre]:my-2 [&_pre]:rounded-[10px] [&_pre]:bg-[var(--fill-tertiary)] [&_pre]:p-3 [&_pre]:text-[13px]",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-[var(--separator)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-tertiary)]",
  "[&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:text-[var(--text-quaternary)] [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
].join(" ")

export const BODY_PLACEHOLDER = "Describe the work — type ## for a heading, - for a list"

export function BodyEditor({
  body,
  editable,
  isDark,
  onCommit,
  editorRef,
}: {
  body: string | null
  /** Edit authority (§3.4). Read-only renders WITHOUT the hover fill. */
  editable: boolean
  isDark: boolean
  onCommit: (markdown: string) => void
  /** Test seam: receives the TipTap instance (jsdom cannot type into PM). */
  editorRef?: React.MutableRefObject<ReturnType<typeof useEditor> | null>
}) {
  const lastCommitted = useRef(body ?? "")
  const editor = useEditor(
    {
      editable,
      extensions: [
        StarterKit,
        Placeholder.configure({ placeholder: BODY_PLACEHOLDER }),
        Markdown.configure({ html: false, transformPastedText: true }),
      ],
      content: body ?? "",
      editorProps: {
        attributes: { class: EDITOR_PROSE_CLASS, "data-testid": "task-body-editor" },
      },
      onBlur: ({ editor: instance }) => {
        const markdown = (instance.storage.markdown.getMarkdown() as string).trim()
        if (markdown !== lastCommitted.current.trim()) {
          lastCommitted.current = markdown
          onCommit(markdown)
        }
      },
    },
    [editable],
  )

  useEffect(() => {
    if (editorRef) editorRef.current = editor
  }, [editor, editorRef])

  // A remote change (poll, another surface) re-seeds the editor only while the
  // caret is elsewhere — never clobber in-progress typing.
  useEffect(() => {
    if (!editor || editor.isFocused) return
    const next = body ?? ""
    if (next.trim() === lastCommitted.current.trim()) return
    lastCommitted.current = next
    editor.commands.setContent(next)
  }, [editor, body])

  if (!editable) {
    return body ? (
      <MarkdownView content={body} isDark={isDark} />
    ) : (
      <p className="text-[16px] leading-[1.6] text-[var(--text-quaternary)]">{BODY_PLACEHOLDER}</p>
    )
  }

  return <EditorContent editor={editor} />
}
