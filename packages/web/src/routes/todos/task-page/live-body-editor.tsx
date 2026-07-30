import { useEffect, useRef, useState } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { Markdown } from "tiptap-markdown"
import { BODY_PLACEHOLDER } from "./body-editor-constants"

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
 * This heavy module is mounted only while editing. The lightweight wrapper
 * owns the read-only MarkdownView and keeps it visible while this chunk loads.
 * Commit happens on blur; the page's PATCH lane owns optimism + refusal
 * snapback.
 *
 * LOSSY-GRAMMAR STORY (stage-B review F1 residual, stage-C decision): the
 * live editor only edits bodies its parse→serialize round-trip preserves
 * BYTE-FAITHFULLY (modulo trim). When the mount/re-seed round-trip is not
 * identity — tables (StarterKit has no table node), `- [x]` checklist
 * grammar, literal HTML, setext headings, `*` bullets, `1)` markers — the
 * body renders through the shared MarkdownView (which DOES render tables and
 * HTML) and tap-to-edit opens a RAW markdown textarea instead, so a genuine
 * edit never normalizes regions the operator didn't touch and agent-authored
 * grammar survives verbatim. This is deterministic and total: no grammar
 * classification, just "did the round-trip change anything?". The chosen
 * option is the review's read-only-fallback strengthened to keep the edit
 * affordance (byte-faithful raw editing), rather than the table extension or
 * `html: true` — neither covers every destructive grammar. */

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

export function LiveBodyEditor({
  body,
  onCommit,
  editorRef,
  onExit,
}: {
  body: string | null
  onCommit: (markdown: string) => void
  /** Test seam: receives the TipTap instance (jsdom cannot type into PM). */
  editorRef?: React.MutableRefObject<unknown | null>
  onExit: () => void
}) {
  /** Last RAW body prop we seeded/committed — the remote re-seed comparator. */
  const lastRaw = useRef(body ?? "")
  /** The editor's OWN serialization of its current document — the commit
   *  baseline. Seeded from `getMarkdown()` after mount and after every
   *  re-seed, NEVER from the raw body: parse→serialize is not identity for
   *  non-canonical grammar (tables, `- [x]`, literal HTML, setext headings),
   *  and a zero-edit focus+blur must commit NOTHING (stage-B review F1 —
   *  normalization may only accompany a genuine edit). */
  const lastCommitted = useRef<string | null>(null)
  /** Round-trip faithfulness: false routes editing to the raw fallback. */
  const [faithful, setFaithful] = useState(true)
  const editor = useEditor(
    {
      editable: true,
      extensions: [
        StarterKit,
        Placeholder.configure({ placeholder: BODY_PLACEHOLDER }),
        Markdown.configure({ html: false, transformPastedText: true }),
      ],
      content: body ?? "",
      editorProps: {
        attributes: { class: EDITOR_PROSE_CLASS, "data-testid": "task-body-editor" },
      },
      onCreate: ({ editor: instance }) => {
        const serialized = instance.storage.markdown.getMarkdown() as string
        lastCommitted.current = serialized
        const isFaithful = serialized.trim() === (lastRaw.current ?? "").trim()
        setFaithful(isFaithful)
        if (isFaithful) queueMicrotask(() => instance.commands.focus("end"))
      },
      onBlur: ({ editor: instance }) => {
        const markdown = (instance.storage.markdown.getMarkdown() as string).trim()
        if (markdown !== (lastCommitted.current ?? "").trim()) {
          lastCommitted.current = markdown
          lastRaw.current = markdown
          onCommit(markdown)
        }
        onExit()
      },
    },
    [],
  )

  useEffect(() => {
    if (editorRef) editorRef.current = editor
    return () => {
      if (editorRef) editorRef.current = null
    }
  }, [editor, editorRef])

  // A remote change (poll, another surface) re-seeds the editor only while the
  // caret is elsewhere — never clobber in-progress typing. The commit baseline
  // re-seeds from the editor's own serialization of the new document (F1), and
  // faithfulness is re-judged for the new body.
  useEffect(() => {
    if (!editor || editor.isFocused) return
    const next = body ?? ""
    if (next.trim() === lastRaw.current.trim()) return
    lastRaw.current = next
    editor.commands.setContent(next)
    const serialized = editor.storage.markdown.getMarkdown() as string
    lastCommitted.current = serialized
    setFaithful(serialized.trim() === next.trim())
  }, [editor, body])

  // Keep the unrendered live document aligned long enough for the raw commit;
  // the wrapper exits edit mode immediately after blur.
  const commitRaw = (next: string) => {
    lastRaw.current = next
    onCommit(next)
    if (editor) {
      editor.commands.setContent(next)
      const serialized = editor.storage.markdown.getMarkdown() as string
      lastCommitted.current = serialized
      setFaithful(serialized.trim() === next.trim())
    }
  }

  if (!faithful) {
    return <RawMarkdownBody body={body} onCommit={commitRaw} onExit={onExit} />
  }

  return <EditorContent editor={editor} />
}

/** Byte-faithful editing for bodies the live round-trip cannot preserve.
 *  Esc reverts; blur commits only a genuine change. */
function RawMarkdownBody({
  body,
  onCommit,
  onExit,
}: {
  body: string | null
  onCommit: (markdown: string) => void
  onExit: () => void
}) {
  const [draft, setDraft] = useState(body ?? "")

  return (
    <div>
      <textarea
        autoFocus
        data-testid="task-body-raw-edit"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim()
          if (next !== (body ?? "").trim()) onCommit(next)
          onExit()
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            setDraft(body ?? "")
            onExit()
          }
        }}
        rows={Math.max(4, draft.split("\n").length + 1)}
        className="w-full resize-none bg-transparent text-[14px] leading-[1.6] text-[var(--text-secondary)] outline-none"
        style={{ fontFamily: "var(--font-code)" }}
        aria-label="Edit description as markdown"
      />
      <p className="mt-1.5 text-[12px] text-[var(--text-quaternary)]">
        Editing raw markdown — this description uses formatting the live editor can&rsquo;t preserve, so it edits byte-faithfully.
      </p>
    </div>
  )
}
