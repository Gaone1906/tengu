export interface StaleChatPolicy {
  enabled: boolean
  tokenThreshold: number
  staleAfterMinutes: number
}

export interface FreshChatSuggestionInput {
  policy: StaleChatPolicy
  status?: string | null
  contextTokens?: number | null
  lastActivity?: string | null
  now: number
  dismissed: boolean
}

const DISMISSALS_KEY = 'jinn-stale-chat-dismissals'
const MAX_DISMISSALS = 100

function dismissalStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function readDismissals(storage: Storage | null = dismissalStorage()): string[] {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(DISMISSALS_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function shouldSuggestFreshChat(input: FreshChatSuggestionInput): boolean {
  if (!input.policy.enabled || input.status === 'running' || input.dismissed) return false
  if (typeof input.contextTokens !== 'number' || input.contextTokens < input.policy.tokenThreshold) return false
  if (!input.lastActivity) return false
  const lastActivity = Date.parse(input.lastActivity)
  if (!Number.isFinite(lastActivity)) return false
  return input.now - lastActivity >= input.policy.staleAfterMinutes * 60_000
}

export function isStaleChatDismissed(sessionId: string): boolean {
  return readDismissals().includes(sessionId)
}

export function dismissStaleChat(sessionId: string): void {
  const storage = dismissalStorage()
  if (!storage) return
  const next = [...readDismissals(storage).filter((id) => id !== sessionId), sessionId].slice(-MAX_DISMISSALS)
  try {
    storage.setItem(DISMISSALS_KEY, JSON.stringify(next))
  } catch {
    // Dismissal is a convenience; quota or disabled storage must not break chat.
  }
}

export function buildContinuationPrompt(previousSessionId: string): string {
  return `This chat is a continuation of session ${previousSessionId}. Read enough of that session to recover the relevant context, then acknowledge the handoff in one line before continuing. Do not restart the task.`
}
