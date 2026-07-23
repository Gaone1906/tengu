import { ChevronLeft, ChevronRight, Copy, Link as LinkIcon, MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { todoPath } from "@/lib/todo-id"

/* Todos v2 slice 6 — the task page's breadcrumb bar (design-doc §7.1, mock
 * task-detail.html). Board context › ancestor IDs › current ID + title. The
 * board name is the back affordance; copy-link and ⋯ sit at the bar's right.
 * Ancestors render as bare mono IDs; only the current segment carries the
 * title (single-line ellipsis — polish law 18). */

export interface CrumbAncestor {
  id: string
  title: string
}

function Csep() {
  return (
    <ChevronRight
      size={11}
      strokeWidth={2.2}
      aria-hidden
      className="flex-none text-[var(--text-quaternary)]"
    />
  )
}

export function CrumbBar({
  boardLabel,
  onBack,
  ancestors,
  id,
  title,
  onOpenAncestor,
  mobile,
}: {
  boardLabel: string
  onBack: () => void
  ancestors: CrumbAncestor[]
  id: string
  title: string
  onOpenAncestor: (id: string) => void
  mobile: boolean
}) {
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {})
  return (
    <div
      data-testid="task-crumb-bar"
      className={
        mobile
          ? "flex items-center gap-2 px-2 pb-2 pt-[calc(10px+var(--safe-top,0px))]"
          : "flex items-center gap-2 py-[16px] pb-3 pl-[96px] pr-[64px]"
      }
    >
      {mobile ? (
        <button
          type="button"
          aria-label="Back"
          data-testid="task-crumb-back"
          onClick={onBack}
          className="focus-ring grid size-8 flex-none place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
        >
          <ChevronLeft size={17} strokeWidth={2.2} aria-hidden />
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          {/* Text sits on the 96px spine; the wash bleeds -8px (polish law 5). */}
          <button
            type="button"
            data-testid="task-crumb-board"
            onClick={onBack}
            className="focus-ring -mx-2 -my-1 rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-primary)]"
          >
            {boardLabel}
          </button>
          <Csep />
          {ancestors.map((ancestor) => (
            <span key={ancestor.id} className="flex items-center gap-2">
              <button
                type="button"
                data-testid={`task-crumb-${ancestor.id}`}
                onClick={() => onOpenAncestor(ancestor.id)}
                title={ancestor.title}
                className="focus-ring -mx-1 rounded-md px-1 text-[11.5px] tracking-[.04em] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
                style={{ fontFamily: "var(--font-code)" }}
              >
                {ancestor.id}
              </button>
              <Csep />
            </span>
          ))}
          <span
            className="flex-none text-[11.5px] tracking-[.04em] text-[var(--text-tertiary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {id}
          </span>
          <span className="min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
        </div>
      )}

      <div className="ml-auto flex flex-none gap-0.5">
        <button
          type="button"
          aria-label={`Copy link to ${id}`}
          data-testid="task-copy-link"
          onClick={() => copy(`${window.location.origin}${todoPath(id)}`)}
          className="focus-ring grid size-8 place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
        >
          <LinkIcon size={14} strokeWidth={2} aria-hidden />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              data-testid="task-crumb-more"
              className="focus-ring grid size-8 place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
            >
              <MoreHorizontal size={16} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-[180px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
          >
            <DropdownMenuItem
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[9px] px-2.5 text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)]"
              onClick={() => copy(id)}
            >
              <Copy size={13} aria-hidden />
              Copy ID
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
