import { Folder, FolderOpen } from "lucide-react"
import type { NoteFolder } from "./types"
import { cn } from "@/lib/utils"

interface NoteSidebarProps {
  folders: NoteFolder[]
  total: number
  selectedFolder: string | null
  onSelect: (folder: string | null) => void
}

export function NoteSidebar({ folders, total, selectedFolder, onSelect }: NoteSidebarProps) {
  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--sidebar-bg)] px-3 pb-5 pt-5 shadow-[var(--shadow-subtle)] lg:px-3.5">
      <header className="flex min-h-12 items-center px-1.5">
        <h1 className="text-balance text-[length:var(--text-title1)] font-[var(--weight-bold)] leading-[var(--leading-tight)] tracking-[var(--tracking-tight)]">
          Folders
        </h1>
      </header>

      <div className="mt-3 px-2 pb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
        Notes
      </div>
      <div className="min-h-0 overflow-y-auto">
        <FolderRow
          name="All Notes"
          count={total}
          selected={selectedFolder === null}
          onClick={() => onSelect(null)}
          all
        />
        {folders.map((folder) => (
          <FolderRow
            key={folder.path || "root"}
            name={folder.name || "Notes"}
            count={folder.count}
            depth={Math.max(0, folder.path.split("/").filter(Boolean).length - 1)}
            selected={selectedFolder === folder.path}
            onClick={() => onSelect(folder.path)}
          />
        ))}
      </div>
    </section>
  )
}

function FolderRow({
  name,
  count,
  selected,
  onClick,
  depth = 0,
  all = false,
}: {
  name: string
  count: number
  selected: boolean
  onClick: () => void
  depth?: number
  all?: boolean
}) {
  const Icon = selected || all ? FolderOpen : Folder
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={selected}
      onClick={onClick}
      style={{ paddingInlineStart: `${10 + depth * 16}px` }}
      className={cn(
        "flex min-h-11 w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 text-left transition-[scale,background-color,color] duration-150 active:scale-[0.96]",
        selected
          ? "bg-[var(--accent-fill)] text-[var(--accent)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]",
      )}
    >
      <Icon size={19} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
        {name}
      </span>
      <span className="tabular-nums text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        {count}
      </span>
    </button>
  )
}
