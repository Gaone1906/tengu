import type { Employee, WorkItemDetailWire } from "@/lib/api"
import type { BoardGroup } from "@/lib/todos"
import { StateCircle } from "./state-glyph"
import { TodoCard } from "./card"

/* GRS-021d — Active, the board reborn. Desktop = calm columns (separation from
 * whitespace + card shadow, no rest hairlines). Mobile = a grouped vertical list
 * (GRS-019 Rail logic — no horizontal board idiom at phone scale). Empty groups
 * keep their column on desktop for structure, but fold away on mobile. */

export function ActiveView({
  groups,
  detailById,
  byName,
  onOpen,
  now,
}: {
  groups: BoardGroup[]
  detailById: Map<string, WorkItemDetailWire>
  byName: Map<string, Employee>
  onOpen: (id: string) => void
  now?: number
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-5 md:gap-4" data-testid="todos-board">
      {groups.map((g) => (
        <section key={g.group} className={`flex min-w-0 flex-col gap-2.5 ${g.items.length === 0 ? "max-md:hidden" : ""}`}>
          <div className="flex items-center gap-2 px-1 pb-0.5">
            <StateCircle keyOf={g.group} size={22} />
            <span className="text-[length:var(--text-footnote)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-secondary)]">
              {g.label}
            </span>
            <span className="ml-auto text-[length:var(--text-caption1)] tabular-nums text-[var(--text-quaternary)]">
              {g.items.length}
            </span>
          </div>
          {g.items.map((item) => (
            <TodoCard key={item.id} item={item} detail={detailById.get(item.id)} byName={byName} onOpen={onOpen} now={now} />
          ))}
        </section>
      ))}
    </div>
  )
}
