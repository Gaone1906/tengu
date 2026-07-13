import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { chatScopeLabel, type ChatScope, type ProjectScopeOption } from './chat-scope'

interface ChatScopeMenuProps {
  value: ChatScope
  projects: ProjectScopeOption[]
  totalCount: number
  needsCount: number
  onChange: (scope: ChatScope) => void
}

function chatCount(count: number): string {
  return `${count} ${count === 1 ? 'chat' : 'chats'}`
}

function MenuCount({ children }: { children: number }) {
  return (
    <span className="ml-auto pl-5 text-[11px] tabular-nums text-[var(--text-tertiary)]">
      {children}
    </span>
  )
}

export function ChatScopeMenu({ value, projects, totalCount, needsCount, onChange }: ChatScopeMenuProps) {
  const label = chatScopeLabel(value, projects)
  const selectedCount = value === 'all'
    ? totalCount
    : value === 'needs'
      ? needsCount
      : projects.find((project) => `project:${project.id}` === value)?.count ?? totalCount

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Chat scope: ${label}, ${chatCount(selectedCount)}`}
          className="group/scope flex h-10 min-w-0 max-w-[220px] items-center gap-1.5 rounded-[var(--radius-md)] px-1.5 text-left transition-[background-color,scale] duration-150 [transition-timing-function:var(--ease-smooth)] hover:bg-[var(--fill-tertiary)] active:scale-[0.96] motion-reduce:transition-none"
        >
          <span className="min-w-0 truncate text-[13px] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {label}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
            {chatCount(selectedCount)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 group-data-[state=open]/scope:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-[240px] rounded-[var(--radius-lg)] border-0 bg-[var(--bg-tertiary)] p-1.5 shadow-[var(--shadow-overlay)]"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as ChatScope)}>
          <DropdownMenuRadioItem
            value="all"
            className="min-h-10 rounded-[var(--radius-md)] text-[13px] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-primary)]"
          >
            All chats
            <MenuCount>{totalCount}</MenuCount>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="needs"
            className="min-h-10 rounded-[var(--radius-md)] text-[13px] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-primary)]"
          >
            Needs you
            <MenuCount>{needsCount}</MenuCount>
          </DropdownMenuRadioItem>
          {projects.length > 0 ? (
            <>
              <DropdownMenuSeparator className="mx-2 bg-[var(--separator)]" />
              <DropdownMenuLabel className="px-2 pb-1 pt-2 text-[10px] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
                Projects
              </DropdownMenuLabel>
              {projects.map((project) => (
                <DropdownMenuRadioItem
                  key={project.id}
                  value={`project:${project.id}`}
                  className="min-h-10 rounded-[var(--radius-md)] text-[13px] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-primary)]"
                >
                  <span className="min-w-0 truncate">{project.label}</span>
                  <MenuCount>{project.count}</MenuCount>
                </DropdownMenuRadioItem>
              ))}
            </>
          ) : null}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
