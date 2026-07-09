/**
 * Per-engine "show all models" preference for the chat model picker. The picker
 * shows an engine's featured models by default; expanding to the full list is a
 * deliberate action we remember so an operator who wants the long list keeps it.
 */
const STORAGE_KEY = 'jinn-model-picker-expanded'

function load(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

/** Snapshot of the expand flag for every engine (for the picker's initial state). */
export function loadExpandedByEngine(): Record<string, boolean> {
  return load()
}

/** Whether the full model list is expanded for a given engine. */
export function isEngineExpanded(engine: string): boolean {
  return load()[engine] === true
}

/** Persist the expand flag for one engine, leaving the others untouched. */
export function setEngineExpanded(engine: string, expanded: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), [engine]: expanded }))
  } catch {
    // Ignore quota / disabled storage — the pref is a convenience, not load-bearing.
  }
}
