import type { TodoDraftPatch } from "./use-todo-draft"

const SALT_KEY = "jinn:todo-tab-salt:v1"
const JOURNAL_KEY = "jinn:todo-draft-journal:v2"
const JOURNAL_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_JOURNALS = 50

interface JournalEnvelope {
  expiresAt: number
  payload: string
}

interface JournalPayload {
  revision: number
  patch: TodoDraftPatch
  baselineVersion?: string
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

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decode<T>(value: string): T | null {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return null
  }
}

function readEnvelopes(now = Date.now()): Record<string, JournalEnvelope> {
  const store = storage()
  if (!store) return {}
  let parsed: Record<string, JournalEnvelope> = {}
  try {
    const candidate = JSON.parse(store.getItem(JOURNAL_KEY) ?? "{}") as Record<string, JournalEnvelope>
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate
  } catch {
    // Corrupt journals are orphaned state; discard them below.
  }
  const valid = Object.entries(parsed)
    .filter(([ref, entry]) => /^td_[a-z0-9]+$/i.test(ref)
      && Number.isFinite(entry?.expiresAt)
      && entry.expiresAt > now
      && typeof entry.payload === "string"
      && decode<JournalPayload>(entry.payload) !== null)
    .sort((a, b) => b[1].expiresAt - a[1].expiresAt)
    .slice(0, MAX_JOURNALS)
  const cleaned = Object.fromEntries(valid)
  try {
    if (valid.length === 0) store.removeItem(JOURNAL_KEY)
    else if (valid.length !== Object.keys(parsed).length) store.setItem(JOURNAL_KEY, JSON.stringify(cleaned))
  } catch { /* storage is best-effort */ }
  return cleaned
}

function validPayload(value: JournalPayload | null): value is JournalPayload {
  if (!value || !Number.isInteger(value.revision) || value.revision <= 0) return false
  if (!value.patch || typeof value.patch !== "object" || Array.isArray(value.patch)) return false
  const allowed = new Set(["title", "body", "assignee", "department", "priority"])
  return Object.keys(value.patch).every((key) => allowed.has(key))
}

export function loadTodoJournal(id: string): JournalPayload | null {
  const entry = readEnvelopes()[todoPrivateRef(id)]
  if (!entry) return null
  const payload = decode<JournalPayload>(entry.payload)
  return validPayload(payload) ? payload : null
}

export function persistTodoJournal(id: string, payload: JournalPayload): void {
  const store = storage()
  if (!store) return
  try {
    const journals = readEnvelopes()
    journals[todoPrivateRef(id)] = {
      expiresAt: Date.now() + JOURNAL_TTL_MS,
      payload: encode(payload),
    }
    store.setItem(JOURNAL_KEY, JSON.stringify(journals))
  } catch {
    // Storage may be unavailable in hardened/private contexts. The mounted
    // revision queue remains authoritative until navigation or reload.
  }
}

export function clearTodoJournal(id: string, throughRevision?: number): void {
  const store = storage()
  if (!store) return
  try {
    const journals = readEnvelopes()
    const ref = todoPrivateRef(id)
    const current = journals[ref]
    if (!current) return
    const payload = decode<JournalPayload>(current.payload)
    if (throughRevision != null && payload && payload.revision > throughRevision) return
    delete journals[ref]
    if (Object.keys(journals).length === 0) store.removeItem(JOURNAL_KEY)
    else store.setItem(JOURNAL_KEY, JSON.stringify(journals))
  } catch { /* storage is best-effort */ }
}
