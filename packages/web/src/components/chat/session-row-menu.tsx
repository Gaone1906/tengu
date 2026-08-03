import { Archive, ArchiveRestore, Copy, ExternalLink, Pencil, Pin, PinOff, Square, Trash2 } from "lucide-react"
import { Link } from "react-router-dom"
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

export const SESSION_MENU_CONTENT_CLASS =
  "min-w-[210px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
export const SESSION_MENU_ITEM_CLASS =
  "flex min-h-9 cursor-pointer items-center gap-2 rounded-[9px] px-2.5 text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-primary)] [&_svg]:size-[13px] [&_svg]:text-[var(--text-tertiary)]"
export const SESSION_MENU_SEPARATOR_CLASS = "mx-2 my-1 bg-[var(--separator)]"

export interface SessionMenuSession {
  id: string
  status?: string
  source?: string
  sourceRef?: string
}

export function workflowRunPath(sourceRef: string | undefined): string | null {
  if (!sourceRef) return null
  const parts = sourceRef.split(":")
  if (
    parts.length !== 5 ||
    parts[0] !== "workflow" ||
    parts.slice(1).some((part) => part.length === 0) ||
    !/^\d+$/.test(parts[4]!)
  ) return null
  return `/workflow/${encodeURIComponent(parts[1]!)}/runs/${encodeURIComponent(parts[2]!)}`
}

export function sessionMenuCapabilities(session: SessionMenuSession): {
  workflowRunPath: string | null
  canStop: boolean
} {
  return {
    workflowRunPath: session.source === "workflow" ? workflowRunPath(session.sourceRef) : null,
    canStop: session.status === "running",
  }
}

export function SessionRowMenu({
  variant,
  session,
  isPinned,
  isArchived,
  onRename,
  onTogglePin,
  onDuplicate,
  onArchive,
  onStop,
  onDelete,
}: {
  variant: "dropdown" | "context"
  session: SessionMenuSession
  isPinned: boolean
  isArchived: boolean
  onRename: () => void
  onTogglePin: () => void
  onDuplicate: () => void
  onArchive: () => void
  onStop: () => void
  onDelete: () => void
}) {
  const capabilities = sessionMenuCapabilities(session)
  const Item = variant === "dropdown" ? DropdownMenuItem : ContextMenuItem
  const Separator = variant === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator

  const copySessionId = () => {
    const copy = navigator.clipboard?.writeText(session.id)
    if (copy) void copy.catch(() => {})
  }

  return (
    <>
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={onRename}>
        <Pencil aria-hidden />
        Rename
      </Item>
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={onTogglePin}>
        {isPinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
        {isPinned ? "Unpin" : "Pin"}
      </Item>
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={onDuplicate}>
        <Copy aria-hidden />
        Duplicate…
      </Item>
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={onArchive}>
        {isArchived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        {isArchived ? "Unarchive chat" : "Archive chat"}
      </Item>
      <Separator className={SESSION_MENU_SEPARATOR_CLASS} />
      {capabilities.workflowRunPath ? (
        <Item asChild className={SESSION_MENU_ITEM_CLASS}>
          <Link to={capabilities.workflowRunPath}>
            <ExternalLink aria-hidden />
            Open workflow run
          </Link>
        </Item>
      ) : null}
      {capabilities.canStop ? (
        <Item className={SESSION_MENU_ITEM_CLASS} onClick={onStop}>
          <Square aria-hidden />
          Stop session
        </Item>
      ) : null}
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={copySessionId}>
        <Copy aria-hidden />
        Copy Session ID
      </Item>
      <Separator className={SESSION_MENU_SEPARATOR_CLASS} />
      <Item
        variant="destructive"
        className={`${SESSION_MENU_ITEM_CLASS} text-[var(--system-red)] focus:text-[var(--system-red)] [&_svg]:text-[var(--system-red)]`}
        onClick={onDelete}
      >
        <Trash2 aria-hidden />
        <span className="flex-1">Delete session</span>
        {variant === "context" ? (
          <kbd className="ml-auto pl-3 font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
        ) : null}
      </Item>
    </>
  )
}
