import { ChevronLeft, FilePlus2, Search } from "lucide-react"
import type { NoteSummary } from "./types"
import { cn } from "@/lib/utils"

interface NoteListProps {
  notes: NoteSummary[]
  selectedPath: string | null
  query: string
  loading?: boolean
  error?: boolean
  onQueryChange: (query: string) => void
  onSelect: (path: string) => void
  onCreate: () => void
  onBack?: () => void
}
function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Recently"
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

export function NoteList({
  notes,
  selectedPath,
  query,
  loading,
  error,
  onQueryChange,
  onSelect,
  onCreate,
  onBack,
}: NoteListProps) {
  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-tertiary)] px-3 pb-5 pt-5 shadow-[var(--shadow-subtle)] lg:px-3.5">
      <header className="flex min-h-12 items-center justify-between px-1.5">
        <div className="flex min-w-0 items-center">
          {onBack && (
            <button
              type="button"
              aria-label="Back to folders"
              onClick={onBack}
              className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-[var(--accent)] transition-[scale,background-color] duration-150 active:scale-[0.96] hover:bg-[var(--fill-secondary)] lg:hidden"
            >
              <ChevronLeft size={25} aria-hidden />
            </button>
          )}
          <h1 className="truncate text-balance text-[length:var(--text-title1)] font-[var(--weight-bold)] leading-[var(--leading-tight)] tracking-[var(--tracking-tight)]">
            Notes
          </h1>
        </div>
        <button
          type="button"
          aria-label="New note"
          onClick={onCreate}
          className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-[var(--accent)] transition-[scale,background-color] duration-150 active:scale-[0.96] hover:bg-[var(--fill-secondary)]"
        >
          <FilePlus2 size={21} aria-hidden />
        </button>
      </header>

      <label className="mx-1.5 my-3 flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-secondary)] px-3 text-[var(--text-tertiary)] focus-within:shadow-[0_0_0_3px_var(--accent-fill)]">
        <Search size={18} aria-hidden />
        <span className="sr-only">Search notes</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search"
          className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
        />
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {loading ? (
          <QuietState label="Loading notes…" />
        ) : error ? (
          <QuietState label="Notes could not be loaded." />
        ) : notes.length === 0 ? (
          <QuietState label={query ? "No notes match this search." : "No notes in this folder yet."} />
        ) : (
          <div className="rounded-[var(--radius-2xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
            {notes.map((note) => (
              <button
                key={note.path}
                type="button"
                aria-pressed={selectedPath === note.path}
                onClick={() => onSelect(note.path)}
                className={cn(
                  "flex min-h-[94px] w-full flex-col justify-center rounded-[17px] px-3.5 py-3 text-left transition-[scale,background-color] duration-150 active:scale-[0.98]",
                  selectedPath === note.path
                    ? "bg-[var(--accent-fill)]"
                    : "hover:bg-[var(--fill-quaternary)]",
                )}
              >
                <span className="w-full truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] leading-[var(--leading-snug)] text-[var(--text-primary)]">
                  {note.title}
                </span>
                <span className="mt-1 flex w-full gap-2 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                  <span className="tabular-nums shrink-0">{formatUpdatedAt(note.updatedAt)}</span>
                  <span className="truncate">{note.folder || "Notes"}</span>
                </span>
                <span className="mt-1 line-clamp-2 w-full text-pretty text-[length:var(--text-footnote)] leading-[var(--leading-snug)] text-[var(--text-secondary)]">
                  {note.preview || "No additional text"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function QuietState({ label }: { label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center px-6 text-center text-pretty text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
      {label}
    </div>
  )
}
