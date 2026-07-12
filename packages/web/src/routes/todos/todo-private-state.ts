import type { TodoDraftPatch, TodoEditableDraft } from "./use-todo-draft"
import type { WorkItemEditRequest } from "@/lib/api"

const SALT_KEY = "jinn:todo-tab-salt:v1"
const JOURNAL_KEY = "jinn:todo-draft-journal:v2"
const JOURNAL_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_JOURNALS = 50
const SALT_PATTERN = /^[a-z0-9-]{12,}$/i

export type TodoDraftField = keyof TodoEditableDraft

export type TodoJournalRequestState = "prepared" | "dispatched" | "uncertain" | "failed" | "conflict"
export type TodoJournalFailureCode = "TODO_IDEMPOTENCY_CONFLICT"

export interface TodoJournalRequest extends WorkItemEditRequest {
  revision: number
  state: TodoJournalRequestState
  /** Closed, privacy-safe recovery classification; never a backend message. */
  failureCode?: TodoJournalFailureCode
}

export type TodoJournalRequestFingerprint = WorkItemEditRequest & { revision: number }

export interface TodoJournalPayload {
  revision: number
  /** Same-origin recovery intentionally stores operator-authored dirty values. */
  patch: TodoDraftPatch
  /** Baselines are limited to the same dirty fields so same-field conflicts can be detected. */
  baseline: TodoDraftPatch
  /** Numeric versions are modern; timestamp strings belong only to request-less legacy v2 recovery. */
  baselineVersion?: string | number
  /** A response was lost for these fields; only a server reconciliation may clear them. */
  uncertainFields?: TodoDraftField[]
  /** Durable reconciliation provenance, independent of transport state. */
  conflictFields?: TodoDraftField[]
  /** A confirmed acknowledgement/discard is waiting only on journal removal. */
  cleanupPending?: true
  /** Fields changed after cleanup began; exact, ordered provenance rather than a union. */
  cleanupIntentFields?: TodoDraftField[]
  /** Save was explicitly requested while cleanup was blocked. */
  cleanupSaveRequested?: true
  /** Present only after a logical conditional edit has been prepared. */
  request?: TodoJournalRequest
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
  if (existing && SALT_PATTERN.test(existing)) return existing
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

function existingTodoPrivateRef(id: string): string | null {
  const store = storage()
  if (!store) return null
  try {
    const salt = store.getItem(SALT_KEY)
    return salt && SALT_PATTERN.test(salt) ? digest(`${salt}\u0000${id}`) : null
  } catch {
    return null
  }
}

const FIELDS = new Set<TodoDraftField>(["title", "body", "assignee", "department", "priority"])
const PAYLOAD_KEYS = new Set([
  "revision", "patch", "baseline", "baselineVersion", "uncertainFields", "conflictFields", "cleanupPending",
  "cleanupIntentFields", "cleanupSaveRequested", "request",
])
const REQUEST_KEYS = new Set(["revision", "patch", "expectedVersion", "idempotencyKey", "state", "failureCode"])
const ENVELOPE_KEYS = new Set(["expiresAt", "sequence", "payload"])
const REQUEST_STATES = new Set<TodoJournalRequestState>(["prepared", "dispatched", "uncertain", "failed", "conflict"])
const FAILURE_CODES = new Set<TodoJournalFailureCode>(["TODO_IDEMPOTENCY_CONFLICT"])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function validPatch(value: unknown): value is TodoDraftPatch {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, fieldValue]) => {
    if (!FIELDS.has(key as TodoDraftField)) return false
    if (key === "title" || key === "body") return typeof fieldValue === "string"
    if (key === "assignee" || key === "department") return fieldValue === null || typeof fieldValue === "string"
    return key === "priority" && typeof fieldValue === "number" && Number.isFinite(fieldValue)
  })
}

function samePatchFields(a: TodoDraftPatch, b: TodoDraftPatch): boolean {
  const aKeys = Object.keys(a) as TodoDraftField[]
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && aKeys.every((field) => Object.prototype.hasOwnProperty.call(b, field))
}

function samePatch(a: TodoDraftPatch, b: TodoDraftPatch): boolean {
  return samePatchFields(a, b)
    && (Object.keys(a) as TodoDraftField[]).every((field) => Object.is(a[field], b[field]))
}

function sameOptionalFields(a?: TodoDraftField[], b?: TodoDraftField[]): boolean {
  if (!a || !b) return a === b
  return a.length === b.length && a.every((field) => b.includes(field))
}

function sameJournalRequest(a?: TodoJournalRequest, b?: TodoJournalRequest): boolean {
  if (!a || !b) return a === b
  return a.state === b.state && a.failureCode === b.failureCode && sameRequestFingerprint(a, b)
}

function samePayload(a: TodoJournalPayload, b: TodoJournalPayload): boolean {
  return a.revision === b.revision
    && Object.is(a.baselineVersion, b.baselineVersion)
    && samePatch(a.patch, b.patch)
    && samePatch(a.baseline, b.baseline)
    && sameOptionalFields(a.uncertainFields, b.uncertainFields)
    && sameOptionalFields(a.conflictFields, b.conflictFields)
    && a.cleanupPending === b.cleanupPending
    && sameOptionalFields(a.cleanupIntentFields, b.cleanupIntentFields)
    && a.cleanupSaveRequested === b.cleanupSaveRequested
    && sameJournalRequest(a.request, b.request)
}

function patchFieldsCoveredBy(active: TodoDraftPatch, latest: TodoDraftPatch): boolean {
  return Object.keys(active).every((field) => Object.prototype.hasOwnProperty.call(latest, field))
}

function validRequest(
  value: unknown,
  latestRevision: number,
  latestPatch: TodoDraftPatch,
  latestBaseline: TodoDraftPatch,
): value is TodoJournalRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_KEYS)) return false
  if (!isPositiveSafeInteger(value.revision) || value.revision > latestRevision) return false
  if (!validPatch(value.patch)
    || !patchFieldsCoveredBy(value.patch, latestPatch)
    || !patchFieldsCoveredBy(value.patch, latestBaseline)) return false
  return isPositiveSafeInteger(value.expectedVersion)
    && typeof value.idempotencyKey === "string"
    && UUID_PATTERN.test(value.idempotencyKey)
    && REQUEST_STATES.has(value.state as TodoJournalRequestState)
    && (value.failureCode === undefined
      || (value.state === "failed" && FAILURE_CODES.has(value.failureCode as TodoJournalFailureCode)))
}

function validUncertainFields(value: unknown, patch: TodoDraftPatch): value is TodoDraftField[] | undefined {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  const fields = value as unknown[]
  return new Set(fields).size === fields.length
    && fields.every((field) => typeof field === "string"
      && FIELDS.has(field as TodoDraftField)
      && Object.prototype.hasOwnProperty.call(patch, field))
}

function validConflictFields(value: unknown, patch: TodoDraftPatch): value is TodoDraftField[] | undefined {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  const fields = value as unknown[]
  return fields.length > 0
    && new Set(fields).size === fields.length
    && fields.every((field) => typeof field === "string"
      && FIELDS.has(field as TodoDraftField)
      && Object.prototype.hasOwnProperty.call(patch, field))
}

function validCleanupIntentFields(value: unknown, patch: TodoDraftPatch): value is TodoDraftField[] | undefined {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  const fields = value as unknown[]
  return new Set(fields).size === fields.length
    && fields.every((field) => typeof field === "string"
      && FIELDS.has(field as TodoDraftField)
      && Object.prototype.hasOwnProperty.call(patch, field))
}

function validPayload(value: unknown): value is TodoJournalPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, PAYLOAD_KEYS)) return false
  if (!isPositiveSafeInteger(value.revision) || !validPatch(value.patch) || !validPatch(value.baseline)) return false
  if (!samePatchFields(value.patch, value.baseline)
    || !validUncertainFields(value.uncertainFields, value.patch)
    || !validConflictFields(value.conflictFields, value.patch)
    || !validCleanupIntentFields(value.cleanupIntentFields, value.patch)
    || (value.cleanupPending !== undefined && value.cleanupPending !== true)
    || (value.cleanupSaveRequested !== undefined && value.cleanupSaveRequested !== true)
    || (!value.cleanupPending && (value.cleanupIntentFields !== undefined || value.cleanupSaveRequested !== undefined))) return false

  if (value.request === undefined) {
    // The legacy v2 string was an updatedAt-like recovery marker, never a CAS
    // version. Keep it recoverable without synthesising request metadata.
    return value.baselineVersion === undefined
      || typeof value.baselineVersion === "string"
      || isPositiveSafeInteger(value.baselineVersion)
  }
  return validRequest(value.request, value.revision, value.patch, value.baseline)
    && isPositiveSafeInteger(value.baselineVersion)
    && value.baselineVersion === value.request.expectedVersion
}

function validTransitionPayload(value: unknown): value is TodoJournalPayload {
  return validPayload(value) && isPositiveSafeInteger(value.baselineVersion)
}

const SAFE_REQUEST_TRANSITIONS: Readonly<Record<TodoJournalRequestState, ReadonlySet<TodoJournalRequestState>>> = {
  prepared: new Set(["prepared", "dispatched", "uncertain", "failed", "conflict"]),
  dispatched: new Set(["dispatched", "uncertain", "failed", "conflict"]),
  uncertain: new Set(["uncertain", "conflict"]),
  failed: new Set(["failed", "dispatched", "conflict"]),
  conflict: new Set(["conflict"]),
}

function validRequestFingerprint(value: unknown): value is TodoJournalRequestFingerprint {
  return isRecord(value)
    && isPositiveSafeInteger(value.revision)
    && validPatch(value.patch)
    && isPositiveSafeInteger(value.expectedVersion)
    && typeof value.idempotencyKey === "string"
    && UUID_PATTERN.test(value.idempotencyKey)
}

function sameRequestFingerprint(a: TodoJournalRequestFingerprint, b: TodoJournalRequestFingerprint): boolean {
  return a.revision === b.revision
    && a.expectedVersion === b.expectedVersion
    && a.idempotencyKey === b.idempotencyKey
    && samePatch(a.patch, b.patch)
}

function sameDesiredIntent(a: TodoJournalPayload, b: TodoJournalPayload): boolean {
  return a.revision === b.revision
    && a.baselineVersion === b.baselineVersion
    && samePatch(a.patch, b.patch)
    && samePatch(a.baseline, b.baseline)
}

function unionFields(a?: TodoDraftField[], b?: TodoDraftField[]): TodoDraftField[] | undefined {
  const fields = [...new Set([...(a ?? []), ...(b ?? [])])]
  return fields.length > 0 ? fields : undefined
}

function protectedRequest(current: TodoJournalRequest, incoming: TodoJournalRequest): TodoJournalRequest {
  const state = SAFE_REQUEST_TRANSITIONS[current.state].has(incoming.state)
    ? incoming.state
    : current.state
  const failureCode = state === "failed"
    ? incoming.failureCode ?? current.failureCode
    : undefined
  return { ...current, state, failureCode }
}

function validEnvelope(ref: string, value: unknown, now: number): value is JournalEnvelope {
  if (!/^td_[a-z0-9]+$/i.test(ref) || !isRecord(value) || !hasOnlyKeys(value, ENVELOPE_KEYS)) return false
  return typeof value.expiresAt === "number"
    && Number.isFinite(value.expiresAt)
    && value.expiresAt > now
    && isPositiveSafeInteger(value.sequence)
    && validPayload(value.payload)
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
    const ref = todoPrivateRef(id)
    const current = journals[ref]?.payload
    let nextPayload = payload
    if (current?.request) {
      if (!payload.request || !sameRequestFingerprint(current.request, payload.request)) return
      const latestIntent = payload.revision < current.revision
        || (payload.revision === current.revision && !sameDesiredIntent(current, payload))
        ? current
        : payload
      const request = protectedRequest(current.request, payload.request)
      const uncertainFields = request.state === "uncertain"
        ? [...new Set([
          ...(current.uncertainFields ?? []),
          ...(latestIntent.uncertainFields ?? []),
          ...Object.keys(request.patch) as TodoDraftField[],
        ])]
        : latestIntent.uncertainFields
      nextPayload = {
        ...latestIntent,
        uncertainFields,
        conflictFields: unionFields(current.conflictFields, payload.conflictFields),
        cleanupPending: current.cleanupPending || payload.cleanupPending || undefined,
        cleanupIntentFields: latestIntent.cleanupIntentFields,
        cleanupSaveRequested: current.cleanupSaveRequested || latestIntent.cleanupSaveRequested || undefined,
        request,
      }
    } else if (current && payload.revision < current.revision) {
      return
    } else if (current) {
      nextPayload = {
        ...payload,
        conflictFields: unionFields(current.conflictFields, payload.conflictFields),
        cleanupPending: current.cleanupPending || payload.cleanupPending || undefined,
        cleanupIntentFields: payload.cleanupIntentFields,
        cleanupSaveRequested: current.cleanupSaveRequested || payload.cleanupSaveRequested || undefined,
      }
    }
    const sequence = Math.max(0, ...Object.values(journals).map((entry) => entry.sequence)) + 1
    journals[ref] = { expiresAt: now + JOURNAL_TTL_MS, sequence, payload: nextPayload }
    const capped = Object.fromEntries(orderedEntries(journals).slice(0, MAX_JOURNALS))
    store.setItem(JOURNAL_KEY, JSON.stringify(capped))
  } catch {
    // Storage may be unavailable in hardened/private contexts. The mounted
    // revision queue remains authoritative until navigation or reload.
  }
}

/** Atomically replace one exact durable journal payload. Identity stays behind
 * the existing tab-private surrogate; callers never persist or compare raw IDs. */
export function transitionTodoJournalPayload(
  id: string,
  expectedPayload: TodoJournalPayload,
  nextPayload: TodoJournalPayload | null,
): boolean {
  const store = storage()
  if (!store || !validPayload(expectedPayload) || (nextPayload !== null && !validPayload(nextPayload))) return false
  try {
    const ref = existingTodoPrivateRef(id)
    if (!ref) return false
    const now = Date.now()
    const parsed = parseEnvelopes()
    const journals = Object.fromEntries(
      Object.entries(parsed).filter(([candidate, entry]) => validEnvelope(candidate, entry, now)),
    ) as Record<string, JournalEnvelope>
    const current = journals[ref]?.payload
    if (!current || !samePayload(current, expectedPayload)) return false

    delete journals[ref]
    if (nextPayload !== null) {
      const sequence = Math.max(0, ...Object.values(journals).map((entry) => entry.sequence)) + 1
      journals[ref] = { expiresAt: now + JOURNAL_TTL_MS, sequence, payload: nextPayload }
    }
    const capped = Object.fromEntries(orderedEntries(journals).slice(0, MAX_JOURNALS))
    if (Object.keys(capped).length === 0) store.removeItem(JOURNAL_KEY)
    else store.setItem(JOURNAL_KEY, JSON.stringify(capped))
    const stored = readEnvelopes(Date.now(), false)[ref]?.payload
    return nextPayload === null ? stored === undefined : !!stored && samePayload(stored, nextPayload)
  } catch {
    return false
  }
}

/** Atomically retire the exact active request and install its post-response
 * recovery state. A stale response can never clear or replace another request. */
export function transitionTodoJournal(
  id: string,
  expectedActiveRequest: TodoJournalRequestFingerprint,
  expectedCurrentRevision: number,
  nextPayload: TodoJournalPayload | null,
): boolean {
  const store = storage()
  if (!store
    || !validRequestFingerprint(expectedActiveRequest)
    || !isPositiveSafeInteger(expectedCurrentRevision)) return false
  if (nextPayload !== null
    && (!validTransitionPayload(nextPayload) || nextPayload.revision < expectedCurrentRevision)) return false
  try {
    const ref = existingTodoPrivateRef(id)
    if (!ref) return false
    const now = Date.now()
    const parsed = parseEnvelopes()
    const journals = Object.fromEntries(
      Object.entries(parsed).filter(([ref, entry]) => validEnvelope(ref, entry, now)),
    ) as Record<string, JournalEnvelope>
    const currentPayload = journals[ref]?.payload
    const activeRequest = currentPayload?.request
    if (currentPayload?.revision !== expectedCurrentRevision
      || !activeRequest
      || !sameRequestFingerprint(activeRequest, expectedActiveRequest)) return false

    delete journals[ref]
    if (nextPayload !== null) {
      const sequence = Math.max(0, ...Object.values(journals).map((entry) => entry.sequence)) + 1
      journals[ref] = { expiresAt: now + JOURNAL_TTL_MS, sequence, payload: nextPayload }
    }
    const capped = Object.fromEntries(orderedEntries(journals).slice(0, MAX_JOURNALS))
    if (Object.keys(capped).length === 0) store.removeItem(JOURNAL_KEY)
    else store.setItem(JOURNAL_KEY, JSON.stringify(capped))
    const stored = readEnvelopes(Date.now(), false)[ref]?.payload
    return nextPayload === null ? stored === undefined : !!stored && samePayload(stored, nextPayload)
  } catch {
    return false
  }
}

export function clearTodoJournalByRef(ref: string, throughRevision?: number): boolean {
  const store = storage()
  if (!store || !/^td_[a-z0-9]+$/i.test(ref)) return false
  try {
    const journals = readEnvelopes()
    const current = journals[ref]
    if (!current) return true
    if (throughRevision != null && current.payload.revision > throughRevision) return false
    delete journals[ref]
    if (Object.keys(journals).length === 0) store.removeItem(JOURNAL_KEY)
    else store.setItem(JOURNAL_KEY, JSON.stringify(journals))
    return !readEnvelopes(Date.now(), false)[ref]
  } catch {
    return false
  }
}

export function clearTodoJournal(id: string, throughRevision?: number): boolean {
  return clearTodoJournalByRef(todoPrivateRef(id), throughRevision)
}
