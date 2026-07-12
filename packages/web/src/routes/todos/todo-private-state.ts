import type { TodoDraftPatch, TodoEditableDraft } from "./use-todo-draft"

const SALT_KEY = "jinn:todo-tab-salt:v1"
const JOURNAL_KEY = "jinn:todo-draft-journal:v2"
const JOURNAL_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_JOURNALS = 50

export type TodoDraftField = keyof TodoEditableDraft

export interface TodoJournalPayload {
  revision: number
  /** Same-origin recovery intentionally stores operator-authored dirty values. */
  patch: TodoDraftPatch
  /** Baselines are limited to the same dirty fields so same-field conflicts can be detected. */
  baseline: TodoDraftPatch
  baselineVersion?: string
  /** A response was lost for these fields; only a server reconciliation may clear them. */
  uncertainFields?: TodoDraftField[]
}

interface JournalEnvelope {
  expiresAt: number
  sequence: number
  payload: TodoJournalPayload
}

function storage(): Storage | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage
}

function randomSalt(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto?.getRandomValues?.(bytes)
  if (bytes.some(Boolean)) return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

function tabSalt(): string {
  const store = storage()
  if (!store) return "ephemeral"
  const existing = store.getItem(SALT_KEY)
  if (existing && /^[a-z0-9-]{12,}$/i.test(existing)) return existing
  const next = randomSalt()
  try { store.setItem(SALT_KEY, next) } catch { /* in-memory editing still works */ }
  return next
}

function digest(value: string): string {
  // Two independently seeded FNV-1a lanes provide a compact, tab-salted
  // surrogate. This is identity minimisation, not a canonical Todo key.
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x85ebca6b)
  }
  return `td_${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`
}

/** A private, per-tab navigation/storage surrogate. It is deliberately not a
 * user-facing or canonical JIN-N identifier. */
export function todoPrivateRef(id: string): string {
  return digest(`${tabSalt()}\u0000${id}`)
}

const FIELDS = new Set<TodoDraftField>(["title", "body", "assignee", "department", "priority"])

function validPatch(value: unknown): value is TodoDraftPatch {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => FIELDS.has(key as TodoDraftField))
}

function validPayload(value: unknown): value is TodoJournalPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const payload = value as Partial<TodoJournalPayload>
  return Number.isInteger(payload.revision)
    && (payload.revision ?? 0) > 0
    && validPatch(payload.patch)
    && validPatch(payload.baseline)
    && (payload.baselineVersion === undefined || typeof payload.baselineVersion === "string")
    && (payload.uncertainFields === undefined
      || (Array.isArray(payload.uncertainFields) && payload.uncertainFields.every((field) => FIELDS.has(field))))
}

function validEnvelope(ref: string, value: unknown, now: number): value is JournalEnvelope {
  if (!/^td_[a-z0-9]+$/i.test(ref) || !value || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Partial<JournalEnvelope>
  return Number.isFinite(envelope.expiresAt)
    && (envelope.expiresAt ?? 0) > now
    && Number.isInteger(envelope.sequence)
    && (envelope.sequence ?? 0) > 0
    && validPayload(envelope.payload)
}

function parseEnvelopes(): Record<string, unknown> {
  const store = storage()
  if (!store) return {}
  try {
    const parsed = JSON.parse(store.getItem(JOURNAL_KEY) ?? "{}") as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function orderedEntries(values: Record<string, JournalEnvelope>): Array<[string, JournalEnvelope]> {
  return Object.entries(values).sort((a, b) =>
    b[1].expiresAt - a[1].expiresAt
      || b[1].sequence - a[1].sequence
      || a[0].localeCompare(b[0]),
  )
}

function readEnvelopes(now = Date.now(), clean = true): Record<string, JournalEnvelope> {
  const store = storage()
  if (!store) return {}
  const parsed = parseEnvelopes()
  const valid = Object.fromEntries(
    Object.entries(parsed).filter(([ref, entry]) => validEnvelope(ref, entry, now)),
  ) as Record<string, JournalEnvelope>
  const cleaned = Object.fromEntries(orderedEntries(valid).slice(0, MAX_JOURNALS))
  if (clean && JSON.stringify(parsed) !== JSON.stringify(cleaned)) {
    try {
      if (Object.keys(cleaned).length === 0) store.removeItem(JOURNAL_KEY)
      else store.setItem(JOURNAL_KEY, JSON.stringify(cleaned))
    } catch { /* storage is best-effort */ }
  }
  return cleaned
}

export function loadTodoJournal(id: string): TodoJournalPayload | null {
  return readEnvelopes()[todoPrivateRef(id)]?.payload ?? null
}

export function persistTodoJournal(id: string, payload: TodoJournalPayload): void {
  const store = storage()
  if (!store || !validPayload(payload)) return
  try {
    // Parse/filter without a cleanup write: insertion, ordering, capping, and
    // persistence are one deterministic storage mutation.
    const now = Date.now()
    const parsed = parseEnvelopes()
    const journals = Object.fromEntries(
      Object.entries(parsed).filter(([ref, entry]) => validEnvelope(ref, entry, now)),
    ) as Record<string, JournalEnvelope>
    const sequence = Math.max(0, ...Object.values(journals).map((entry) => entry.sequence)) + 1
    journals[todoPrivateRef(id)] = { expiresAt: now + JOURNAL_TTL_MS, sequence, payload }
    const capped = Object.fromEntries(orderedEntries(journals).slice(0, MAX_JOURNALS))
    store.setItem(JOURNAL_KEY, JSON.stringify(capped))
  } catch {
    // Storage may be unavailable in hardened/private contexts. The mounted
    // revision queue remains authoritative until navigation or reload.
  }
}

export function clearTodoJournalByRef(ref: string, throughRevision?: number): void {
  const store = storage()
  if (!store || !/^td_[a-z0-9]+$/i.test(ref)) return
  try {
    const journals = readEnvelopes()
    const current = journals[ref]
    if (!current) return
    if (throughRevision != null && current.payload.revision > throughRevision) return
    delete journals[ref]
    if (Object.keys(journals).length === 0) store.removeItem(JOURNAL_KEY)
    else store.setItem(JOURNAL_KEY, JSON.stringify(journals))
  } catch { /* storage is best-effort */ }
}

export function clearTodoJournal(id: string, throughRevision?: number): void {
  clearTodoJournalByRef(todoPrivateRef(id), throughRevision)
}
