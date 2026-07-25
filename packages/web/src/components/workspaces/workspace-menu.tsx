import { useState } from "react"
import { Check, ChevronRight, Layers3, LoaderCircle, Plus } from "lucide-react"
import type { WorkspaceInfo } from "@/lib/api"
import { useStartWorkspace, useWorkspaces } from "@/hooks/use-workspaces"
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

function WorkspaceRow({
  workspace,
  onStart,
  starting,
  error,
}: {
  workspace: WorkspaceInfo
  onStart: (workspace: WorkspaceInfo) => void
  starting: boolean
  error?: string
}) {
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
          {workspace.current ? "Current workspace" : workspace.running ? "Online" : starting ? "Starting…" : error ?? "Offline"}
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
  if (!workspace.current) {
    return (
      <DropdownMenuItem
        aria-label={`Start ${workspace.displayName}`}
        disabled={starting}
        onSelect={(event) => {
          event.preventDefault()
          onStart(workspace)
        }}
        className="min-h-12 rounded-[10px] p-2.5 focus:bg-[var(--fill-secondary)] disabled:opacity-100"
      >
        {content}
        {starting && <LoaderCircle size={15} className="animate-spin text-[var(--text-tertiary)]" aria-hidden />}
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
  onStart,
  startingId,
  startError,
  className,
}: {
  workspaces: WorkspaceInfo[]
  onAdd: () => void
  onStart: (workspace: WorkspaceInfo) => void
  startingId?: string
  startError?: { id: string; message: string } | null
  className?: string
}) {
  const [showOffline, setShowOffline] = useState(false)

  // A workspace stays in the always-visible group while it is starting or is
  // showing a start error, so its row never vanishes mid-action when the
  // offline section happens to be collapsed.
  const isVisible = (workspace: WorkspaceInfo) =>
    workspace.running ||
    workspace.current ||
    (workspace.id !== undefined && (startingId === workspace.id || startError?.id === workspace.id))
  const online = workspaces.filter(isVisible)
  const offline = workspaces.filter((workspace) => !isVisible(workspace))

  // A gateway older than this launcher serves rows without an id, so every
  // `=== workspace.id` must survive undefined on both sides.
  const renderRow = (workspace: WorkspaceInfo) => (
    <WorkspaceRow
      key={workspace.id ?? workspace.name}
      workspace={workspace}
      onStart={onStart}
      starting={workspace.id !== undefined && startingId === workspace.id}
      error={startError && startError.id === workspace.id ? startError.message : undefined}
    />
  )

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
        {online.map(renderRow)}
        {offline.length > 0 && (
          // Kept as a DropdownMenuItem (not a Collapsible) so Radix's roving
          // tabindex and typeahead still work; preventDefault keeps the menu
          // open on select, matching the model picker's "More models" toggle.
          <DropdownMenuItem
            aria-expanded={showOffline}
            onSelect={(event) => {
              event.preventDefault()
              setShowOffline((value) => !value)
            }}
            className="min-h-9 rounded-[10px] px-2.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-secondary)]"
          >
            <ChevronRight
              size={13}
              aria-hidden
              className={cn(
                "shrink-0 text-[var(--text-quaternary)] transition-transform duration-150",
                showOffline && "rotate-90",
              )}
            />
            {showOffline ? "Hide offline" : `${offline.length} offline`}
          </DropdownMenuItem>
        )}
        {showOffline && offline.map(renderRow)}
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
  const startWorkspace = useStartWorkspace()
  const [creating, setCreating] = useState(false)
  const [startError, setStartError] = useState<{ id: string; message: string } | null>(null)

  async function handleStart(workspace: WorkspaceInfo) {
    setStartError(null)
    try {
      const started = await startWorkspace.mutateAsync(workspace.id)
      window.location.assign(started.switchUrl)
    } catch (error) {
      setStartError({ id: workspace.id, message: error instanceof Error ? error.message : "Could not start workspace" })
    }
  }

  return (
    <>
      <WorkspaceLauncher
        workspaces={data}
        onAdd={() => setCreating(true)}
        onStart={(workspace) => void handleStart(workspace)}
        startingId={startWorkspace.isPending ? startWorkspace.variables : undefined}
        startError={startError}
      />
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}
