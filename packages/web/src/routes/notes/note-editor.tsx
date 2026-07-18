import { useCallback, useEffect, useRef, useState } from "react"
import { Check, ChevronLeft, PenLine, RotateCcw, ShieldAlert } from "lucide-react"
import { ApiError, api } from "@/lib/api"
import { MarkdownView } from "@/components/markdown-view"
import { cn } from "@/lib/utils"
import type { NoteDocument } from "./types"
import {
  clearNoteDraft,
  insertTranscript,
  loadNoteDraft,
  persistNoteDraft,
} from "./note-content"
import { NoteMic } from "./note-mic"

type SavePhase = "saved" | "unsaved" | "saving" | "conflict" | "error"

interface EditableNote {
  title: string
  body: string
}

export function formatEditedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Edited recently"
  return `Edited ${date.toLocaleDateString([], { month: "short", day: "numeric" })} at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
}

function saveLabel(phase: SavePhase): string {
  if (phase === "saving") return "Saving…"
  if (phase === "unsaved") return "Not saved"
  if (phase === "conflict") return "Changed elsewhere"
  if (phase === "error") return "Save paused"
  return "Saved"
}

function useRevisionSafeNote(note: NoteDocument, onSaved?: (note: NoteDocument) => void) {
  const [draft, setDraft] = useState<EditableNote>({ title: note.title, body: note.body })
  const [phase, setPhase] = useState<SavePhase>("saved")
  const [message, setMessage] = useState<string | null>(null)
  const latestRef = useRef(draft)
  const pathRef = useRef(note.path)
  const revisionRef = useRef(note.revision)
  const editSequenceRef = useRef(0)
  const acknowledgedSequenceRef = useRef(0)
  const savingRef = useRef(false)
  const conflictRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const flush = useCallback(async () => {
    if (savingRef.current || conflictRef.current) return
    if (acknowledgedSequenceRef.current >= editSequenceRef.current) return
    savingRef.current = true

    try {
      while (
        mountedRef.current
        && !conflictRef.current
        && acknowledgedSequenceRef.current < editSequenceRef.current
      ) {
        const path = pathRef.current
        const sequence = editSequenceRef.current
        const snapshot = latestRef.current
        setPhase("saving")
        setMessage(null)

        try {
          const { note: saved } = await api.updateNote({
            path,
            expectedRevision: revisionRef.current,
            title: snapshot.title,
            body: snapshot.body,
          })
          if (!mountedRef.current || pathRef.current !== path) return
          revisionRef.current = saved.revision
          acknowledgedSequenceRef.current = sequence
          onSaved?.(saved)

          if (editSequenceRef.current === sequence) {
            clearNoteDraft(path)
            setPhase("saved")
          } else {
            persistNoteDraft(path, {
              ...latestRef.current,
              baseRevision: saved.revision,
              updatedAt: Date.now(),
            })
          }
        } catch (error) {
          if (!mountedRef.current || pathRef.current !== path) return
          if (error instanceof ApiError && error.status === 409) {
            conflictRef.current = true
            setPhase("conflict")
            setMessage("This note changed somewhere else. Your local draft is protected.")
          } else {
            setPhase("error")
            setMessage("The draft is safe on this device. Editing again will retry the save.")
          }
          return
        }
      }
    } finally {
      savingRef.current = false
    }
  }, [onSaved])

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flush() }, 500)
  }, [flush])

  useEffect(() => {
    const stored = loadNoteDraft(note.path)
    const next = stored
      ? { title: stored.title, body: stored.body }
      : { title: note.title, body: note.body }
    pathRef.current = note.path
    revisionRef.current = stored?.baseRevision ?? note.revision
    latestRef.current = next
    editSequenceRef.current = stored ? 1 : 0
    acknowledgedSequenceRef.current = 0
    conflictRef.current = false
    setDraft(next)
    setMessage(null)
    setPhase(stored ? "unsaved" : "saved")
    if (stored) schedule()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // A changed revision for the same open path is an external cache refresh;
    // it must never replace an active local draft. Reinitialize only on identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.path])

  useEffect(() => {
    if (note.path !== pathRef.current || note.revision === revisionRef.current) return
    const hasProtectedDraft = (
      savingRef.current
      || conflictRef.current
      || acknowledgedSequenceRef.current < editSequenceRef.current
    )
    if (hasProtectedDraft) return

    const next = { title: note.title, body: note.body }
    revisionRef.current = note.revision
    latestRef.current = next
    setDraft(next)
    setMessage(null)
    setPhase("saved")
  }, [note.body, note.path, note.revision, note.title])

  useEffect(() => () => { mountedRef.current = false }, [])

  const change = useCallback((next: EditableNote) => {
    latestRef.current = next
    editSequenceRef.current += 1
    setDraft(next)
    persistNoteDraft(pathRef.current, {
      ...next,
      baseRevision: revisionRef.current,
      updatedAt: Date.now(),
    })
    if (!conflictRef.current) {
      setPhase("unsaved")
      setMessage(null)
      schedule()
    }
  }, [schedule])

  const reload = useCallback(async () => {
    setPhase("saving")
    const { note: remote } = await api.readNote(pathRef.current)
    const next = { title: remote.title, body: remote.body }
    revisionRef.current = remote.revision
    latestRef.current = next
    editSequenceRef.current = 0
    acknowledgedSequenceRef.current = 0
    conflictRef.current = false
    clearNoteDraft(remote.path)
    setDraft(next)
    setMessage(null)
    setPhase("saved")
    onSaved?.(remote)
  }, [onSaved])

  const overwrite = useCallback(async () => {
    const path = pathRef.current
    const snapshot = latestRef.current
    const sequence = editSequenceRef.current
    setPhase("saving")
    setMessage(null)
    try {
      const { note: remote } = await api.readNote(path)
      if (pathRef.current !== path) return
      const { note: saved } = await api.updateNote({
        path,
        expectedRevision: remote.revision,
        title: snapshot.title,
        body: snapshot.body,
      })
      if (pathRef.current !== path) return
      revisionRef.current = saved.revision
      acknowledgedSequenceRef.current = sequence
      conflictRef.current = false
      onSaved?.(saved)
      if (editSequenceRef.current === sequence) {
        clearNoteDraft(path)
        setPhase("saved")
      } else {
        setPhase("unsaved")
        schedule()
      }
    } catch {
      conflictRef.current = true
      setPhase("conflict")
      setMessage("The remote note changed again. Your local draft is still protected.")
    }
  }, [onSaved, schedule])

  return { draft, phase, message, change, reload, overwrite }
}

export function NoteEditor({
  note,
  isDark,
  onBack,
  backLabel = "Notes",
  onSaved,
}: {
  note: NoteDocument
  isDark: boolean
  onBack?: () => void
  backLabel?: string
  onSaved?: (note: NoteDocument) => void
}) {
  const editor = useRevisionSafeNote(note, onSaved)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  // The body has two modes: rendered markdown at rest, and a plain textarea for
  // writing. A brand-new / empty note opens straight in writing mode. All save,
  // conflict, draft, and dictation behaviour is unchanged across both.
  const [editing, setEditing] = useState(() => editor.draft.body.trim() === "")

  const startEditing = useCallback((caret?: "end") => {
    setEditing(true)
    requestAnimationFrame(() => {
      const field = bodyRef.current
      if (!field) return
      field.focus()
      if (caret === "end") {
        const end = field.value.length
        field.setSelectionRange(end, end)
      }
    })
  }, [])

  const insertDictation = useCallback((text: string) => {
    setEditing(true)
    const field = bodyRef.current
    const start = field?.selectionStart ?? editor.draft.body.length
    const end = field?.selectionEnd ?? start
    const inserted = insertTranscript(editor.draft.body, text, start, end)
    editor.change({ ...editor.draft, body: inserted.value })
    requestAnimationFrame(() => {
      const el = bodyRef.current
      el?.focus()
      el?.setSelectionRange(inserted.selection, inserted.selection)
    })
  }, [editor])

  const hasBody = editor.draft.body.trim().length > 0

  return (
    <section className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg)]">
      <header className="absolute inset-x-2 top-1 z-10 flex min-h-12 items-center gap-2 lg:inset-x-4 lg:top-2">
        {onBack && (
          <button
            type="button"
            aria-label={`Back to ${backLabel}`}
            onClick={onBack}
            className="-ml-1 flex shrink-0 items-center gap-0.5 text-[length:var(--text-body)] text-[var(--accent)] transition-opacity active:opacity-60 lg:hidden"
          >
            <ChevronLeft size={24} aria-hidden />
            <span className="max-w-[38vw] truncate">{backLabel}</span>
          </button>
        )}
        <span className="absolute left-1/2 -translate-x-1/2 tabular-nums text-[length:var(--text-caption1)] text-[var(--text-tertiary)] lg:static lg:ml-1 lg:translate-x-0">
          {saveLabel(editor.phase)}
        </span>
        <div className="ml-auto flex shrink-0 items-center">
          {editing ? (
            <button
              type="button"
              onClick={() => { bodyRef.current?.blur(); setEditing(false) }}
              className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent)] transition-[scale,background-color] duration-150 active:scale-[0.96] hover:bg-[var(--fill-secondary)]"
            >
              <Check size={17} aria-hidden />
              Done
            </button>
          ) : (
            <button
              type="button"
              aria-label="Edit note"
              onClick={() => startEditing("end")}
              className="flex size-9 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] transition-[scale,background-color,color] duration-150 active:scale-[0.96] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
            >
              <PenLine size={18} aria-hidden />
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-36 pt-16 lg:px-14 lg:pb-32 lg:pt-20">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col">
          <div className="tabular-nums text-center text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {formatEditedAt(note.updatedAt)}
          </div>
          <input
            aria-label="Note title"
            value={editor.draft.title}
            onChange={(event) => editor.change({ ...editor.draft, title: event.target.value })}
            className="notes-title mt-5 w-full border-0 bg-transparent text-balance font-[var(--weight-bold)] leading-[var(--leading-tight)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] lg:mt-7"
            placeholder="Note title"
          />
          {editing ? (
            <textarea
              ref={bodyRef}
              aria-label="Note body"
              value={editor.draft.body}
              onChange={(event) => editor.change({ ...editor.draft, body: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.currentTarget.blur(); setEditing(false) }
              }}
              className="mt-5 min-h-[55vh] w-full flex-1 resize-none border-0 bg-transparent text-pretty text-[length:var(--text-body)] leading-[1.62] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              placeholder="Start writing…"
            />
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label="Edit note body"
              onClick={() => startEditing("end")}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startEditing("end") }
              }}
              className={cn(
                "mt-5 min-h-[55vh] w-full flex-1 cursor-text",
                !hasBody && "text-[length:var(--text-body)] leading-[1.62] text-[var(--text-tertiary)]",
              )}
            >
              {hasBody
                ? <MarkdownView content={editor.draft.body} isDark={isDark} />
                : "Start writing…"}
            </div>
          )}
        </div>
      </div>

      {(editor.phase === "conflict" || editor.phase === "error") && (
        <div
          role="status"
          aria-label={editor.phase === "conflict" ? "Note changed elsewhere" : "Note save paused"}
          className="absolute inset-x-4 top-14 z-20 mx-auto flex max-w-[680px] items-center gap-3 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-3 shadow-[var(--shadow-overlay)] lg:top-16"
        >
          {editor.phase === "conflict" ? (
            <ShieldAlert size={20} className="shrink-0 text-[var(--system-orange)]" aria-hidden />
          ) : (
            <RotateCcw size={20} className="shrink-0 text-[var(--system-orange)]" aria-hidden />
          )}
          <p className="min-w-0 flex-1 text-pretty text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            {editor.message}
          </p>
          {editor.phase === "conflict" && (
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label="Reload remote note"
                onClick={() => { void editor.reload() }}
                className="min-h-10 rounded-[var(--radius-md)] px-3 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-secondary)] transition-[scale,background-color,color] duration-150 active:scale-[0.96] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
              >
                Reload
              </button>
              <button
                type="button"
                aria-label="Overwrite remote note"
                onClick={() => { void editor.overwrite() }}
                className="min-h-10 rounded-[var(--radius-md)] bg-[var(--accent-fill)] px-3 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent)] transition-[scale,background-color] duration-150 active:scale-[0.96] hover:bg-[var(--fill-primary)]"
              >
                Overwrite
              </button>
            </div>
          )}
        </div>
      )}

      <NoteMic onTranscript={insertDictation} />
    </section>
  )
}
