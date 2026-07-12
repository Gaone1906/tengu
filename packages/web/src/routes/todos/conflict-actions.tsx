import type { TodoDraftField } from "./todo-private-state"

const FIELD_LABEL: Record<TodoDraftField, string> = {
  title: "Title",
  body: "Description",
  assignee: "Assignee",
  department: "Department",
  priority: "Priority",
}

function conflictLabel(fields: TodoDraftField[]): string {
  const labels = fields.map((field) => FIELD_LABEL[field])
  if (labels.length === 1) return `${labels[0]} still conflicts`
  if (labels.length === 2) return `${labels[0]} and ${labels[1].toLowerCase()} still conflict`
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)?.toLowerCase()} still conflict`
}

export function TodoConflictActions({
  fields,
  sameFieldConflict,
  busy,
  error,
  onReload,
  onRebase,
  onOverwrite,
}: {
  fields: TodoDraftField[]
  sameFieldConflict: boolean
  busy: boolean
  error?: string | null
  onReload: () => void
  onRebase: () => void
  onOverwrite: () => void
}) {
  const fieldCopy = fields.length === 1 ? FIELD_LABEL[fields[0]].toLowerCase() : "edited fields"

  return (
    <section
      role="status"
      aria-label="Todo changed elsewhere"
      aria-busy={busy}
      className="mb-3 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 shadow-[var(--shadow-subtle)]"
    >
      <div className="flex items-center gap-2 text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)]">
        <span className="size-[7px] flex-none rounded-full bg-[var(--system-orange)]" aria-hidden />
        Todo changed elsewhere
      </div>
      <p className="mt-2 text-pretty text-[length:var(--text-footnote)] leading-[1.48] text-[var(--text-secondary)]">
        {sameFieldConflict
          ? `Your ${fieldCopy} also changed remotely. Reload the remote ${fieldCopy}, or explicitly overwrite it with your edit.`
          : "The Todo changed after you opened it. Rebase keeps unrelated remote work; overwrite applies only your edited fields to the latest version."}
      </p>
      {sameFieldConflict && fields.length > 0 && (
        <span className="mt-2.5 inline-flex min-h-7 items-center rounded-full bg-[var(--fill-secondary)] px-2.5 text-[length:var(--text-caption1)] font-semibold text-[var(--text-secondary)]">
          {conflictLabel(fields)}
        </span>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[length:var(--text-caption1)] text-[var(--system-red)]">
          {error}
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-1 md:flex md:flex-wrap md:justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={onReload}
          className="col-span-2 min-h-11 rounded-full px-3.5 text-[length:var(--text-footnote)] font-semibold text-[var(--text-secondary)] transition-[background-color,transform] hover:bg-[var(--fill-secondary)] active:scale-[0.96] disabled:opacity-50 md:col-auto"
        >
          Reload remote
        </button>
        {!sameFieldConflict && (
          <button
            type="button"
            disabled={busy}
            onClick={onRebase}
            className="min-h-11 rounded-full bg-[var(--fill-secondary)] px-3.5 text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)] transition-transform active:scale-[0.96] disabled:opacity-50"
          >
            Rebase edits
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onOverwrite}
          className={`min-h-11 rounded-full bg-[var(--accent-fill)] px-3.5 text-[length:var(--text-footnote)] font-semibold text-[var(--accent)] transition-transform active:scale-[0.96] disabled:opacity-50 ${sameFieldConflict ? "col-span-2 md:col-auto" : ""}`}
        >
          Overwrite remote
        </button>
      </div>
    </section>
  )
}
