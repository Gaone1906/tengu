import { ChevronLeft, PenSquare, Search } from "lucide-react"
import type { NoteSummary } from "./types"
import { cn } from "@/lib/utils"

interface NoteListProps {
  title: string
  notes: NoteSummary[]
  selectedPath: string | null
  query: string
  loading?: boolean
  error?: boolean
  mobile?: boolean
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
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function SearchField({ query, onQueryChange }: { query: string; onQueryChange: (q: string) => void }) {
  return (
    <label className="flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-secondary)] px-3 text-[var(--text-tertiary)] focus-within:shadow-[0_0_0_3px_var(--accent-fill)]">
      <Search size={17} aria-hidden />
      <span className="sr-only">Search notes</span>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search"
        className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
      />
    </label>
  )
}

export function NoteList({
  title,
  notes,
  selectedPath,
  query,
  loading,
  error,
  mobile,
  onQueryChange,
  onSelect,
  onCreate,
  onBack,
}: NoteListProps) {
  const emptyLabel = loading
    ? "Loading notes…"
    : error
      ? "Notes could not be loaded."
      : query
        ? "No notes match this search."
        : "No notes in this folder yet."
  const showEmpty = loading || error || notes.length === 0

  if (mobile) {
    return (
      <section className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg)]">
        <header className="px-4 pt-1">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="-ml-1 mb-1 flex items-center gap-0.5 text-[length:var(--text-body)] text-[var(--accent)] transition-opacity active:opacity-60"
            >
              <ChevronLeft size={22} aria-hidden />
              <span>Folders</span>
            </button>
          )}
          <h1 className="px-1 text-[length:var(--text-title1)] font-[var(--weight-bold)] leading-[var(--leading-tight)] tracking-[var(--tracking-tight)]">
            {title}
          </h1>
        </header>
        <div className="px-4 py-3">
          <SearchField query={query} onQueryChange={onQueryChange} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24">
          {showEmpty ? (
            <QuietState label={emptyLabel} />
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
              {notes.map((note) => (
                <NoteRow
                  key={note.path}
                  note={note}
                  selected={selectedPath === note.path}
                  onSelect={onSelect}
                  variant="mobile"
                />
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="New note"
          onClick={onCreate}
          className="absolute bottom-5 right-5 flex size-14 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-[var(--shadow-overlay)] transition-[scale] duration-150 active:scale-[0.94]"
        >
          <PenSquare size={24} aria-hidden />
        </button>
      </section>
    )
  }

  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-secondary)] px-3 pb-4 pt-5 lg:px-3.5">
      <header className="flex min-h-9 items-center justify-between px-2.5">
        <h1 className="truncate text-[length:var(--text-title2)] font-[var(--weight-bold)] leading-[var(--leading-tight)] tracking-[var(--tracking-tight)]">
          {title}
        </h1>
        <button
          type="button"
          aria-label="New note"
          onClick={onCreate}
          className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--accent)] transition-[scale,background-color] duration-150 active:scale-[0.96] hover:bg-[var(--fill-secondary)]"
        >
          <PenSquare size={19} aria-hidden />
        </button>
      </header>

      <div className="px-2.5 py-3">
        <SearchField query={query} onQueryChange={onQueryChange} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-0.5 pb-2">
        {showEmpty ? (
          <QuietState label={emptyLabel} />
        ) : (
          notes.map((note) => (
            <NoteRow
              key={note.path}
              note={note}
              selected={selectedPath === note.path}
              onSelect={onSelect}
              variant="desktop"
            />
          ))
        )}
      </div>
    </section>
  )
}

function NoteRow({
  note,
  selected,
  onSelect,
  variant,
}: {
  note: NoteSummary
  selected: boolean
  onSelect: (path: string) => void
  variant: "desktop" | "mobile"
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(note.path)}
      className={cn(
        "flex w-full flex-col justify-center text-left transition-[scale,background-color] duration-150 active:scale-[0.99]",
        variant === "mobile"
          ? cn("notes-inset-row min-h-[62px] gap-0.5 rounded-[var(--radius-lg)] px-3 py-2.5", selected ? "bg-[var(--accent-fill)]" : "active:bg-[var(--fill-quaternary)]")
          : cn("min-h-[60px] gap-0.5 rounded-[var(--radius-lg)] px-3 py-2.5", selected ? "bg-[var(--accent-fill)]" : "hover:bg-[var(--fill-quaternary)]"),
      )}
    >
      <span className={cn(
        "w-full truncate font-[var(--weight-semibold)] leading-[var(--leading-snug)] text-[var(--text-primary)]",
        variant === "mobile" ? "text-[length:var(--text-body)]" : "text-[length:var(--text-subheadline)]",
      )}>
        {note.title}
      </span>
      <span className="flex w-full gap-2 text-[length:var(--text-footnote)]">
        <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">{formatUpdatedAt(note.updatedAt)}</span>
        <span className="truncate text-[var(--text-tertiary)]">{note.preview || "No additional text"}</span>
      </span>
    </button>
  )
}

function QuietState({ label }: { label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center px-6 text-center text-pretty text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
      {label}
    </div>
  )
}
