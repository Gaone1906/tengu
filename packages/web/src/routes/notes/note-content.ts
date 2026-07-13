export interface NoteDraft {
  title: string
  body: string
  baseRevision: string
  updatedAt: number
}

export interface TranscriptInsertion {
  value: string
  selection: number
}

const DRAFT_PREFIX = "jinn:note-draft:v1:"

export function noteDraftKey(path: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(path)}`
}

export function persistNoteDraft(path: string, draft: NoteDraft): void {
  try {
    localStorage.setItem(noteDraftKey(path), JSON.stringify(draft))
  } catch {
    // The live editor still works when storage is unavailable; transport errors
    // remain visible separately and never justify discarding the in-memory text.
  }
}

export function loadNoteDraft(path: string): NoteDraft | null {
  try {
    const raw = localStorage.getItem(noteDraftKey(path))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<NoteDraft>
    if (
      typeof value.title !== "string"
      || typeof value.body !== "string"
      || typeof value.baseRevision !== "string"
      || typeof value.updatedAt !== "number"
      || !Number.isFinite(value.updatedAt)
    ) return null
    return value as NoteDraft
  } catch {
    return null
  }
}

export function clearNoteDraft(path: string): void {
  try { localStorage.removeItem(noteDraftKey(path)) } catch { /* unavailable */ }
}

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value)
}

export function insertTranscript(
  value: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number,
): TranscriptInsertion {
  const start = Math.max(0, Math.min(value.length, selectionStart))
  const end = Math.max(start, Math.min(value.length, selectionEnd))
  const spoken = transcript.trim()
  if (!spoken) return { value, selection: start }

  const before = value.slice(0, start)
  const after = value.slice(end)
  const prefix = before && isWordCharacter(before.at(-1) ?? "") && isWordCharacter(spoken[0]) ? " " : ""
  const suffix = after && isWordCharacter(spoken.at(-1) ?? "") && isWordCharacter(after[0]) ? " " : ""
  const inserted = `${prefix}${spoken}${suffix}`
  return {
    value: `${before}${inserted}${after}`,
    selection: before.length + prefix.length + spoken.length,
  }
}
