import { ChevronRight, Folder, FolderOpen } from "lucide-react"
import type { NoteFolder } from "./types"
import { cn } from "@/lib/utils"

interface NoteSidebarProps {
  folders: NoteFolder[]
  total: number
  selectedFolder: string | null
  listOpen: boolean
  mobile?: boolean
  onSelect: (folder: string | null) => void
}

export function NoteSidebar({ folders, total, selectedFolder, listOpen, mobile, onSelect }: NoteSidebarProps) {
  if (mobile) {
    // iOS Notes "Folders" home: large title over a grouped inset list.
    return (
      <section className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg)]">
        <header className="px-5 pb-2 pt-3">
          <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] leading-[var(--leading-tight)] tracking-[var(--tracking-tight)]">
            Folders
          </h1>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2">
          <div className="overflow-hidden rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
            <MobileFolderRow
              name="All Notes"
              count={total}
              selected={selectedFolder === null && listOpen}
              onClick={() => onSelect(null)}
              all
            />
            {folders.map((folder) => (
              <MobileFolderRow
                key={folder.path || "root"}
                name={folder.name || "Notes"}
                count={folder.count}
                selected={selectedFolder === folder.path}
                onClick={() => onSelect(folder.path)}
              />
            ))}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--sidebar-bg)] px-3 pb-5 pt-5 lg:px-3.5">
      <div className="mb-2 mt-1 px-2.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
        Folders
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        <DesktopFolderRow
          name="All Notes"
          count={total}
          selected={selectedFolder === null}
          onClick={() => onSelect(null)}
          all
        />
        {folders.map((folder) => (
          <DesktopFolderRow
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

function DesktopFolderRow({
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
        "flex h-[34px] w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 text-left transition-[background-color,color] duration-150",
        selected
          ? "bg-[var(--accent-fill)]"
          : "hover:bg-[var(--fill-secondary)]",
      )}
    >
      <Icon size={17} className={cn("shrink-0", selected ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")} aria-hidden />
      <span className={cn(
        "min-w-0 flex-1 truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)]",
        selected ? "text-[var(--accent)]" : "text-[var(--text-primary)]",
      )}>
        {name}
      </span>
      <span className="tabular-nums text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        {count}
      </span>
    </button>
  )
}

function MobileFolderRow({
  name,
  count,
  selected,
  onClick,
  all = false,
}: {
  name: string
  count: number
  selected: boolean
  onClick: () => void
  all?: boolean
}) {
  const Icon = all ? FolderOpen : Folder
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "notes-inset-row flex min-h-[50px] w-full items-center gap-3 rounded-[var(--radius-lg)] px-3 text-left transition-[scale,background-color] duration-150 active:scale-[0.99]",
        selected ? "bg-[var(--accent-fill)]" : "active:bg-[var(--fill-quaternary)]",
      )}
    >
      <Icon size={21} className="shrink-0 text-[var(--accent)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] font-[var(--weight-medium)] text-[var(--text-primary)]">
        {name}
      </span>
      <span className="tabular-nums text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">
        {count}
      </span>
      <ChevronRight size={18} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden />
    </button>
  )
}
