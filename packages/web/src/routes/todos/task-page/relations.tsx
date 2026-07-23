import { useEffect, useMemo, useState } from "react"
import { Plus, X } from "lucide-react"
import { api, type WorkItemCompactWire, type WorkItemRelationKindWire, type WorkItemRelationWire } from "@/lib/api"
import { StatusCircle } from "../state-glyph"

/* Todos v2 slice 6 — the relations section (design-doc §7.2.9, mock
 * task-detail.html): inset rows — kind label (Blocks in orange, the one tinted
 * kind: it gates others' work) + item pill (status disc + mono ID + title),
 * hover × to remove, and an add row that grows a kind picker + item search.
 * Four visible kinds over three wire kinds: "Blocked by" is an incoming
 * `blocks` edge, so adding one writes the edge on the OTHER item. */

export type RelationDisplayKind = "blocks" | "blocked-by" | "relates" | "duplicates"

export function relationDisplayLabel(relation: WorkItemRelationWire): string {
  if (relation.kind === "blocks") return relation.direction === "out" ? "Blocks" : "Blocked by"
  if (relation.kind === "duplicates") return relation.direction === "out" ? "Duplicates" : "Duplicated by"
  return "Relates to"
}

const ADD_KINDS: Array<{ key: RelationDisplayKind; label: string }> = [
  { key: "blocks", label: "Blocks" },
  { key: "blocked-by", label: "Blocked by" },
  { key: "relates", label: "Relates to" },
  { key: "duplicates", label: "Duplicates" },
]

export function RelationsSection({
  id,
  relations,
  onAdd,
  onRemove,
}: {
  id: string
  relations: WorkItemRelationWire[]
  /** (srcId, kind, dstId) — "blocked by" callers swap src/dst before the wire. */
  onAdd: (srcId: string, kind: WorkItemRelationKindWire, dstId: string) => void
  onRemove: (relation: WorkItemRelationWire) => void
}) {
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<RelationDisplayKind>("blocks")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<WorkItemCompactWire[]>([])

  useEffect(() => {
    if (!adding) return
    const text = query.trim()
    if (text.length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void api
        .searchWorkItems({ text, limit: 6 })
        .then((page) => {
          if (!cancelled) setResults(page.workItems.filter((item) => item.id !== id))
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [adding, query, id])

  const submit = (other: WorkItemCompactWire) => {
    if (kind === "blocked-by") onAdd(other.id, "blocks", id)
    else onAdd(id, kind, other.id)
    setAdding(false)
    setQuery("")
    setResults([])
  }

  const rows = useMemo(
    () => [...relations].sort((a, b) => relationDisplayLabel(a).localeCompare(relationDisplayLabel(b))),
    [relations],
  )

  if (rows.length === 0 && !adding) {
    // Empty state: a bare + row only (design's empty-state rule).
    return (
      <section data-testid="task-relations">
        <SectionKicker />
        <AddRow onClick={() => setAdding(true)} />
      </section>
    )
  }

  return (
    <section data-testid="task-relations">
      <SectionKicker />
      {rows.map((relation) => {
        const label = relationDisplayLabel(relation)
        return (
          <div
            key={`${relation.kind}-${relation.direction}-${relation.other.id}`}
            data-testid={`relation-row-${relation.other.id}`}
            className="group/rel -mx-2.5 flex min-h-9 items-center gap-2.5 rounded-[10px] px-2.5 py-[5px] text-[13.5px] hover:bg-[var(--fill-quaternary)]"
          >
            <span
              className={`w-[116px] flex-none pl-[30px] ${
                label === "Blocks" ? "text-[var(--system-orange)]" : "text-[var(--text-tertiary)]"
              }`}
            >
              {label}
            </span>
            <span className="flex min-w-0 items-center gap-[7px]">
              <StatusCircle status={relation.other.status} size={16} />
              <span
                className="whitespace-nowrap text-[11px] text-[var(--text-tertiary)]"
                style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
              >
                {relation.other.id}
              </span>
              <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">{relation.other.title}</span>
            </span>
            <button
              type="button"
              aria-label={`Remove ${label} ${relation.other.id}`}
              data-testid={`relation-remove-${relation.other.id}`}
              onClick={() => onRemove(relation)}
              className="focus-ring ml-auto grid size-6 flex-none place-items-center rounded-md text-[var(--text-quaternary)] opacity-0 outline-none transition-opacity hover:text-[var(--text-secondary)] focus-visible:opacity-100 group-hover/rel:opacity-100"
            >
              <X size={12} strokeWidth={2.2} aria-hidden />
            </button>
          </div>
        )
      })}

      {adding ? (
        <div className="-mx-2.5 rounded-[10px] bg-[var(--fill-quaternary)] p-2" data-testid="relation-add-form">
          <div className="flex flex-wrap items-center gap-1.5 pb-1.5">
            {ADD_KINDS.map((option) => (
              <button
                key={option.key}
                type="button"
                data-testid={`relation-kind-${option.key}`}
                aria-pressed={kind === option.key}
                onClick={() => setKind(option.key)}
                className={`focus-ring h-6 rounded-full px-2.5 text-[11.5px] font-medium outline-none ${
                  kind === option.key
                    ? "bg-[var(--fill-secondary)] text-[var(--text-primary)]"
                    : "text-[var(--text-tertiary)] hover:bg-[var(--fill-tertiary)]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAdding(false)
                setQuery("")
              }
            }}
            placeholder="Search todos…"
            aria-label="Search todos to relate"
            data-testid="relation-search"
            className="w-full rounded-full bg-[var(--fill-tertiary)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
          {results.length > 0 && (
            <div className="mt-1.5 flex flex-col">
              {results.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`relation-result-${item.id}`}
                  onClick={() => submit(item)}
                  className="focus-ring flex min-h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none hover:bg-[var(--fill-tertiary)]"
                >
                  <StatusCircle status={item.status} size={16} />
                  <span className="text-[11px] text-[var(--text-tertiary)]" style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}>
                    {item.id}
                  </span>
                  <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">{item.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <AddRow onClick={() => setAdding(true)} />
      )}
    </section>
  )
}

function SectionKicker() {
  return (
    <div
      className="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--text-secondary)]"
      style={{ fontFamily: "var(--font-code)" }}
    >
      Relations
    </div>
  )
}

function AddRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="relation-add"
      onClick={onClick}
      className="focus-ring -mx-2.5 flex min-h-9 w-[calc(100%+20px)] items-center rounded-[10px] px-2.5 text-left text-[13.5px] font-medium text-[var(--text-quaternary)] outline-none transition-colors hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
    >
      <Plus size={12} strokeWidth={2.2} aria-hidden className="mr-4" />
      Add relation
    </button>
  )
}
