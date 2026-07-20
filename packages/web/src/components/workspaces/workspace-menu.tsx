import { useState } from "react"
import { Check, Layers3, Plus } from "lucide-react"
import type { WorkspaceInfo } from "@/lib/api"
import { useWorkspaces } from "@/hooks/use-workspaces"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"

export type { WorkspaceInfo } from "@/lib/api"

function WorkspaceRow({ workspace }: { workspace: WorkspaceInfo }) {
  const content = (
    <>
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: workspace.running ? "var(--system-green)" : "var(--text-quaternary)" }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
          {workspace.displayName}
        </span>
        <span className="block truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          {workspace.current ? "Current workspace" : workspace.running ? "Online" : "Offline"}
        </span>
      </span>
      {workspace.current && <Check size={15} className="text-[var(--text-secondary)]" aria-hidden />}
    </>
  )
  if (!workspace.current && workspace.running) {
    return (
      <DropdownMenuItem asChild className="min-h-12 rounded-[10px] p-2.5 focus:bg-[var(--fill-secondary)]">
        <a href={workspace.switchUrl} aria-label={`Open ${workspace.displayName}`}>{content}</a>
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuItem disabled className="min-h-12 rounded-[10px] p-2.5 opacity-100 data-[disabled]:opacity-100">
      {content}
    </DropdownMenuItem>
  )
}

export function WorkspaceLauncher({
  workspaces,
  onAdd,
  className,
}: {
  workspaces: WorkspaceInfo[]
  onAdd: () => void
  className?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch workspace"
          title="Switch workspace"
          className={cn(
            "group/row relative flex size-11 shrink-0 items-center justify-center rounded-[12px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--fill-secondary)] data-[state=open]:text-[var(--text-primary)]",
            className,
          )}
        >
          <Layers3 size={20} aria-hidden />
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-full z-50 ml-2 flex items-center">
            <span className="whitespace-nowrap rounded-full border-[0.5px] border-[var(--separator)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] opacity-0 shadow-[var(--shadow-subtle)] transition-[opacity,transform] duration-150 [transition-timing-function:var(--ease-snappy)] motion-safe:-translate-x-1.5 group-hover/row:translate-x-0 group-hover/row:opacity-100 group-focus-within/row:translate-x-0 group-focus-within/row:opacity-100 motion-reduce:transition-opacity">
              Workspaces
            </span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-[238px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] [backdrop-filter:blur(20px)_saturate(1.2)]"
      >
        <DropdownMenuLabel className="px-2.5 pb-1 pt-2 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          Workspaces
        </DropdownMenuLabel>
        {workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}
        <DropdownMenuSeparator className="mx-2 my-1 bg-[var(--separator)]" />
        <DropdownMenuItem
          onSelect={onAdd}
          className="min-h-10 rounded-[10px] px-2.5 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-primary)]"
        >
          <Plus size={17} aria-hidden />
          Add workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WorkspaceSwitcher() {
  const { data = [] } = useWorkspaces()
  const [creating, setCreating] = useState(false)
  return (
    <>
      <WorkspaceLauncher workspaces={data} onAdd={() => setCreating(true)} />
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}
