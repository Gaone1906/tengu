import { isFocusedSession } from './chat-route-helpers'

export type ChatScope = 'all' | 'needs' | `project:${string}`

export interface ProjectScopeOption {
  id: string
  label: string
  count: number
}

export interface ScopeSession {
  id?: string
  source?: string
  sourceRef?: string
  employee?: string | null
  parentSessionId?: string | null
  status?: string
  lastActivity?: string
  workflowProvenance?: { kind?: string } | null
}

type EmployeeDepartment = { department?: string | null }

const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function title(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function projectIdForSession(
  session: ScopeSession,
  employees: ReadonlyMap<string, EmployeeDepartment>,
  portalSlug: string,
): string {
  const employee = session.employee?.trim()
  if (!employee || employee.toLowerCase() === portalSlug.toLowerCase()) return 'general'
  const department = employees.get(employee)?.department
  return department ? slug(department) || 'general' : 'general'
}

export function projectScopeOptions(
  sessions: ScopeSession[],
  employees: ReadonlyMap<string, EmployeeDepartment>,
  portalSlug: string,
): ProjectScopeOption[] {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    const id = projectIdForSession(session, employees, portalSlug)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return Array.from(counts, ([id, count]) => ({ id, label: title(id), count }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function sessionNeedsAttention(session: ScopeSession, nowMs = Date.now()): boolean {
  if (session.status === 'waiting') return true
  if (session.status !== 'error' || !session.lastActivity) return false
  const activity = new Date(session.lastActivity).getTime()
  return Number.isFinite(activity)
    && activity <= nowMs
    && nowMs - activity < RECENT_ERROR_WINDOW_MS
}

export function sessionMatchesScope(
  session: ScopeSession,
  scope: ChatScope,
  employees: ReadonlyMap<string, EmployeeDepartment>,
  portalSlug: string,
  nowMs = Date.now(),
): boolean {
  if (scope === 'all') return true
  if (scope === 'needs') return sessionNeedsAttention(session, nowMs)
  return projectIdForSession(session, employees, portalSlug) === scope.slice('project:'.length)
}

export function parseStoredChatScope(
  stored: string | null | undefined,
  projects: ProjectScopeOption[],
): ChatScope {
  if (stored === 'all' || stored === 'needs') return stored
  if (!stored?.startsWith('project:')) return 'all'
  const projectId = stored.slice('project:'.length)
  return projects.some((project) => project.id === projectId) ? `project:${projectId}` : 'all'
}

export function chatScopeLabel(scope: ChatScope, projects: ProjectScopeOption[]): string {
  if (scope === 'all') return 'All chats'
  if (scope === 'needs') return 'Needs you'
  return projects.find((project) => `project:${project.id}` === scope)?.label ?? 'All chats'
}

export function shouldShowContactableRoster(scope: ChatScope, searching: boolean): boolean {
  return scope === 'all' && !searching
}

export interface ScopePartition<T extends ScopeSession> {
  attention: T[]
  history: T[]
  hiddenAutomated: number
  conversationCount: number
  projects: ProjectScopeOption[]
}

export function partitionSessionsForScope<T extends ScopeSession>(
  sessions: T[],
  scope: ChatScope,
  employees: ReadonlyMap<string, EmployeeDepartment>,
  portalSlug: string,
  nowMs = Date.now(),
  isVisibleSession: (session: T) => boolean = () => true,
): ScopePartition<T> {
  const conversations: T[] = []
  let hiddenAutomated = 0

  for (const session of sessions) {
    if (!isVisibleSession(session)) continue
    if (!isFocusedSession(session)) {
      hiddenAutomated += 1
      continue
    }
    conversations.push(session)
  }

  const attention = conversations.filter((session) => sessionNeedsAttention(session, nowMs))
  const attentionIds = new Set(attention.map((session) => session.id).filter(Boolean))
  const history = scope === 'needs'
    ? []
    : conversations.filter((session) => (
        !attentionIds.has(session.id)
        && sessionMatchesScope(session, scope, employees, portalSlug, nowMs)
      ))

  return {
    attention,
    history,
    hiddenAutomated,
    conversationCount: conversations.length,
    projects: projectScopeOptions(conversations, employees, portalSlug),
  }
}
