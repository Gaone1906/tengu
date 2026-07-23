import { useState } from "react"
import { Check, Plus, X } from "lucide-react"

/* Todos v2 slice 6 — acceptance as a first-class checklist (design-doc §7.2.6,
 * mock task-detail.html): accent rounded boxes, checked items dim. Checks are
 * EDITS to the plain-text `acceptance` column (audited through the metadata
 * PATCH), never status magic. The stored format stays markdown-ish lines —
 * `- [x] done line` / `- [ ] open line` — so agents read it unchanged; bare
 * `- line` / plain lines parse as unchecked. */

export interface AcceptanceLine {
  text: string
  checked: boolean
}

const CHECKBOX_LINE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/
const BULLET_LINE = /^\s*[-*]\s+(.*)$/

export function parseAcceptance(acceptance: string | null): AcceptanceLine[] {
  if (!acceptance) return []
  return acceptance
    .split(/\r?\n/)
    .map((line) => {
      const checkbox = CHECKBOX_LINE.exec(line)
      if (checkbox) return { text: checkbox[2].trim(), checked: checkbox[1].toLowerCase() === "x" }
      const bullet = BULLET_LINE.exec(line)
      if (bullet) return { text: bullet[1].trim(), checked: false }
      return { text: line.trim(), checked: false }
    })
    .filter((line) => line.text.length > 0)
}

export function serializeAcceptance(lines: AcceptanceLine[]): string {
  return lines.map((line) => `- [${line.checked ? "x" : " "}] ${line.text}`).join("\n")
}

export function AcceptanceChecklist({
  acceptance,
  editable,
  onCommit,
}: {
  acceptance: string | null
  editable: boolean
  onCommit: (next: string | null) => void
}) {
  const lines = parseAcceptance(acceptance)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")

  const commit = (next: AcceptanceLine[]) => {
    onCommit(next.length > 0 ? serializeAcceptance(next) : null)
  }
  const toggle = (index: number) => {
    if (!editable) return
    commit(lines.map((line, i) => (i === index ? { ...line, checked: !line.checked } : line)))
  }
  const remove = (index: number) => commit(lines.filter((_, i) => i !== index))
  const submitAdd = () => {
    const text = draft.trim()
    setDraft("")
    setAdding(false)
    if (text) commit([...lines, { text, checked: false }])
  }

  if (lines.length === 0 && !editable) return null

  return (
    <div data-testid="task-acceptance">
      {lines.map((line, index) => (
        <div key={`${index}-${line.text}`} className="group/check flex items-start gap-[13px] py-[5px] text-[15px] leading-[1.4]">
          <button
            type="button"
            role="checkbox"
            aria-checked={line.checked}
            aria-label={line.text}
            data-testid={`acceptance-check-${index}`}
            disabled={!editable}
            onClick={() => toggle(index)}
            className={`focus-ring mt-px grid size-[17px] flex-none place-items-center rounded-[5.5px] outline-none ${
              line.checked ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "bg-[var(--fill-secondary)] text-transparent"
            }`}
          >
            <Check size={11} strokeWidth={3} aria-hidden />
          </button>
          <span className={`min-w-0 flex-1 ${line.checked ? "text-[var(--text-tertiary)]" : "text-[var(--text-secondary)]"}`}>
            {line.text}
          </span>
          {editable && (
            <button
              type="button"
              aria-label={`Remove "${line.text}"`}
              onClick={() => remove(index)}
              className="focus-ring grid size-5 flex-none place-items-center rounded-md text-[var(--text-quaternary)] opacity-0 outline-none transition-opacity hover:text-[var(--text-secondary)] focus-visible:opacity-100 group-hover/check:opacity-100"
            >
              <X size={11} strokeWidth={2.4} aria-hidden />
            </button>
          )}
        </div>
      ))}
      {editable && (
        adding ? (
          <div className="flex items-center gap-[13px] py-[5px]">
            <span className="mt-px grid size-[17px] flex-none place-items-center rounded-[5.5px] bg-[var(--fill-secondary)]" aria-hidden />
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd()
                if (e.key === "Escape") {
                  setDraft("")
                  setAdding(false)
                }
              }}
              onBlur={submitAdd}
              placeholder="Acceptance line"
              aria-label="New acceptance line"
              data-testid="acceptance-add-input"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
            />
          </div>
        ) : (
          <button
            type="button"
            data-testid="acceptance-add"
            onClick={() => setAdding(true)}
            className="focus-ring -mx-2.5 flex min-h-9 w-[calc(100%+20px)] items-center rounded-[10px] px-2.5 text-left text-[13.5px] font-medium text-[var(--text-quaternary)] outline-none transition-colors hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
          >
            <Plus size={12} strokeWidth={2.2} aria-hidden className="mr-4" />
            Add acceptance
          </button>
        )
      )}
    </div>
  )
}
