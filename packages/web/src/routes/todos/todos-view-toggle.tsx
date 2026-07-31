import type { TodoView } from "./todos-view-pref"

export function TodosViewToggle({ view, onChange }: { view: TodoView; onChange: (view: TodoView) => void }) {
  return (
    <div
      role="group"
      aria-label="Todos view"
      className="flex h-9 flex-none items-center rounded-full bg-[var(--fill-quaternary)] p-0.5"
    >
      {(["list", "board"] as const).map((option) => {
        const selected = view === option
        return (
          <button
            key={option}
            type="button"
            data-testid={`todos-view-${option}`}
            aria-pressed={selected}
            onClick={() => onChange(option)}
            className={`focus-ring h-8 rounded-full px-3 text-[12px] font-semibold outline-none transition-[background-color,color,box-shadow] duration-150 active:scale-[0.96] ${
              selected
                ? "bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-subtle)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {option === "list" ? "List" : "Board"}
          </button>
        )
      })}
    </div>
  )
}
