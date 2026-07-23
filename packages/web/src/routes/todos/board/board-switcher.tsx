import { ChevronDown } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DepartmentSummaryWire } from "@/lib/api"
import { boardPath, isSameBoard, type BoardId } from "./board-route"
import { useBoardMenuCounts } from "./use-board"

/* Todos v2 slice 6 — the switcher-in-title (design-doc §1.1, HIG title-menu).
 * The page title IS the menu trigger: current board name + chevron. Rows, in
 * order: My requests (home) · Attention (the ONLY badge anywhere — §8's one
 * ambient signal) · Boards (one per department, mono prefix glyph, open count)
 * · Everything. Open counts load lazily when the menu opens. */

const MENU_CLASS =
  "w-[min(300px,calc(100vw-24px))] rounded-[var(--radius-xl)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const ROW_CLASS =
  "min-h-10 cursor-pointer gap-2.5 rounded-[9px] px-2.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)] focus:bg-[var(--fill-tertiary)]"

export interface BoardSwitcherProps {
  board: BoardId
  title: string
  departments: DepartmentSummaryWire[] | undefined
  attentionCount: number
}

export function BoardSwitcher({ board, title, departments, attentionCount }: BoardSwitcherProps) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const counts = useBoardMenuCounts(departments, open)

  const go = (target: BoardId) => {
    if (!isSameBoard(board, target)) navigate(boardPath(target))
  }
  const countOf = (value: number | undefined) => (
    <span className="ml-auto text-[12px] tabular-nums text-[var(--text-quaternary)]">{value ?? ""}</span>
  )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="board-switcher"
          aria-label={`Board: ${title} — switch board`}
          className="-ml-0.5 flex items-center gap-2 rounded-xl py-0.5 pl-0.5 pr-2.5 transition-colors duration-150 hover:bg-[var(--fill-quaternary)]"
        >
          <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-[1.15] tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
            {title}
          </h1>
          <ChevronDown size={18} strokeWidth={2.2} aria-hidden className="mt-1.5 text-[var(--text-quaternary)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={MENU_CLASS}>
        <DropdownMenuItem className={ROW_CLASS} data-testid="board-menu-my" onClick={() => go({ kind: "my" })}>
          My requests
          {countOf(counts.data?.my)}
        </DropdownMenuItem>
        <DropdownMenuItem className={ROW_CLASS} data-testid="board-menu-attention" onClick={() => go({ kind: "attention" })}>
          Attention
          {attentionCount > 0 && (
            <span className="ml-auto rounded-full bg-[var(--accent-fill)] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[var(--accent)]">
              {attentionCount}
            </span>
          )}
        </DropdownMenuItem>
        {(departments?.length ?? 0) > 0 && (
          <>
            <DropdownMenuLabel className="px-2.5 pb-1 pt-2.5 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              Boards
            </DropdownMenuLabel>
            {departments!.map((dept) => (
              <DropdownMenuItem
                key={dept.slug}
                className={ROW_CLASS}
                data-testid={`board-menu-${dept.slug}`}
                onClick={() => go({ kind: "department", slug: dept.slug })}
              >
                <span
                  className="w-9 flex-none text-[11px] text-[var(--text-quaternary)]"
                  style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
                >
                  {dept.prefix}
                </span>
                <span className="truncate">{departmentTitle(dept.slug)}</span>
                {countOf(counts.data?.byDepartment[dept.slug])}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuItem className={ROW_CLASS} data-testid="board-menu-everything" onClick={() => go({ kind: "everything" })}>
          Everything
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function departmentTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}
