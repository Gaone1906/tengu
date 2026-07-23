import { useCallback, useState } from "react"
import { api, type Employee } from "@/lib/api"
import { operatorSafeTodoError } from "@/lib/todos"
import { TodoDialog } from "./todo-dialog"

/* The New Todo creation dialog — extracted from the retired legacy list page
 * at the stage-C cutover; the board's + affordances are its callers. */

export function NewTodoDialog({
  onClose,
  onCreated,
  defaults,
}: {
  onClose: () => void
  onCreated: () => void
  /** Board quick-adds carry their scope (slice 6): department presets the
   *  birth department; askAssignee renders a roster select and creates-then-
   *  assigns so the item lands in Assigned through the legal backlog→assigned
   *  path. */
  defaults?: { department?: string; askAssignee?: boolean; employees?: Employee[] }
}) {
  const [title, setTitle] = useState("")
  const [assignee, setAssignee] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const create = useCallback(async () => {
    const t = title.trim()
    if (!t || busy) return
    if (defaults?.askAssignee && !assignee) {
      setError("Pick who this is assigned to")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await api.createWorkItem({ title: t, department: defaults?.department })
      if (defaults?.askAssignee && assignee) await api.assignWorkItem(created.workItem.id, assignee)
      onCreated()
    } catch (e) {
      setBusy(false)
      setError(operatorSafeTodoError(e, "Failed to create"))
    }
  }, [title, busy, onCreated, defaults, assignee])

  return (
    <TodoDialog
      label="New todo"
      onRequestClose={() => {
        if (busy) return
        if (title.trim()) setConfirmDiscard(true)
        else onClose()
      }}
      className="inset-x-3 bottom-3 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-bottom-3 sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[400px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:motion-safe:data-[state=open]:zoom-in-95"
    >
        <h2 className="text-[length:var(--text-title3)] font-semibold text-[var(--text-primary)]">New Todo</h2>
        <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">A unit of work for the company. Assign and route it later.</p>
        <input
          autoFocus
          data-testid="todo-new-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create() }}
          placeholder="e.g. Draft the launch note"
          className="apple-input mt-4 min-h-11 w-full"
        />
        {defaults?.askAssignee && (
          <select
            aria-label="Assignee"
            data-testid="todo-new-assignee"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="apple-input mt-2 min-h-11 w-full"
          >
            <option value="">Assign to…</option>
            {(defaults.employees ?? []).map((employee) => (
              <option key={employee.name} value={employee.name}>
                {employee.displayName}
              </option>
            ))}
          </select>
        )}
        {error && <div className="mt-2 text-[length:var(--text-caption1)] text-[var(--system-red)]">{error}</div>}
        {confirmDiscard && (
          <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] p-3 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            <p>Discard this Todo draft?</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={onClose} className="min-h-11 rounded-full px-3 font-semibold text-[var(--system-red)]">Discard</button>
              <button type="button" onClick={() => setConfirmDiscard(false)} className="min-h-11 rounded-full px-3 text-[var(--text-secondary)]">Keep editing</button>
            </div>
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={() => { if (title.trim()) setConfirmDiscard(true); else onClose() }} className="min-h-11 rounded-full px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)]">
            Cancel
          </button>
          <button
            type="button"
            data-testid="todo-new-create"
            disabled={!title.trim() || busy}
            onClick={() => void create()}
            className="min-h-11 rounded-full bg-[var(--accent)] px-5 text-[length:var(--text-subheadline)] font-semibold text-[var(--accent-contrast)] transition-transform hover:scale-[0.98] disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
    </TodoDialog>
  )
}
