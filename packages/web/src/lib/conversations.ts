/**
 * Conversation storage and utility functions for the Jinn chat.
 * Conversations are keyed by sessionId (not agentId).
 */

import type { ChatBlock } from './blocks'

export type MediaType = 'image' | 'audio' | 'video' | 'file'

export interface MediaAttachment {
  type: MediaType
  url: string
  name?: string
  mimeType?: string
  duration?: number
  waveform?: number[]
  size?: number
  /** Server-side file ID after upload (set by chat-pane before sending) */
  fileId?: string
  /** Original File object for upload (not serialized) */
  file?: File
}

/** MIME is authoritative for rows persisted before video became a media type. */
export function isVideoMedia(media: MediaAttachment): boolean {
  return media.type === 'video' || media.mimeType?.startsWith('video/') === true
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'notification'
  content: string
  timestamp: number
  media?: MediaAttachment[]
  toolCall?: string
  toolId?: string
  /** True for a persisted mid-turn row restored while the turn is still active. */
  partial?: boolean
  blocks?: ChatBlock[]
  /** Safe structured UI metadata persisted with notification messages. */
  meta?: Record<string, unknown>
}

/**
 * Content-identity key for a message, independent of its id. Used to recognise a
 * locally-appended optimistic message and its server-persisted twin as the SAME
 * message even though their ids differ. The media fingerprint keys on the file
 * NAME (stable across the optimistic base64-url copy and the server /api/files
 * copy) falling back to type, so it is robust to the url differing and to any
 * media type (image, audio, video → 'file', etc.).
 */
export function messageIdentityKey(m: Message): string {
  const sep = '\u0000'
  const mediaFp = (m.media || [])
    .map((x) => x.name || x.type || x.url)
    .sort()
    .join('|')
  const blockFp = (m.blocks || [])
    .map((x) => `${x.id}:${x.type}:${x.version}`)
    .sort()
    .join('|')
  const baseKey = `${m.role}${sep}${m.content}${sep}${mediaFp}`
  return blockFp ? `${baseKey}${sep}${blockFp}` : baseKey
}

/**
 * Merge a server history snapshot with the current in-memory messages.
 *
 * A message pushed live (e.g. an agent attachment via the `session:attachment` WS
 * event) is persisted server-side, but a history refetch that races ahead of that
 * commit returns a snapshot WITHOUT it. Replacing wholesale would make the live
 * message vanish until the next reload. We therefore keep any locally-known
 * attachment (media-bearing) message that the snapshot does not yet contain.
 *
 * "Does not contain" is checked by BOTH id and content-identity: an optimistic
 * user message carries a client-generated random id while its persisted twin has
 * the server's canonical id, so an id-only check would wrongly preserve the local
 * copy AND show the snapshot copy → a duplicate. Matching on identity collapses
 * the two. Preserved messages are re-sorted by timestamp.
 *
 * That same client-uuid → server-id gap also causes a FLICKER: when the snapshot's
 * persisted twin replaces the optimistic row, the React key changes, remounting the
 * user bubble and every turn/fold region anchored on its id. To avoid it we adopt
 * the persisted twin's content but KEEP the optimistic id and timestamp, so the key
 * stays stable across the swap. This holds across later snapshots too (the local id
 * keeps winning), so the user message never remounts.
 *
 * Preservation is capped by age: a message that failed to persist server-side
 * would otherwise be re-appended on every reconciliation forever. Only messages
 * younger than RECONCILE_PRESERVE_MAX_AGE_MS (by their `timestamp`) are kept —
 * legit in-flight attachments are seconds old, so the window is generous.
 */
export const RECONCILE_PRESERVE_MAX_AGE_MS = 5 * 60 * 1000

export function reconcileMessages(
  current: Message[],
  snapshot: Message[],
  now: number = Date.now(),
): Message[] {
  // Queue local rows by identity so each snapshot row adopts AT MOST ONE local id.
  // messageIdentityKey is content-only, so repeated identical messages ("ok",
  // "yes") share a key; consuming per match keeps two "yes" server rows from both
  // adopting the same optimistic id (which would collide React keys and turn
  // anchors). Order is stable: both arrays are timestamp-sorted.
  const localByKey = new Map<string, Message[]>()
  for (const m of current) {
    const key = messageIdentityKey(m)
    const arr = localByKey.get(key)
    if (arr) arr.push(m)
    else localByKey.set(key, [m])
  }
  let rekeyed = false
  const aligned = snapshot.map((m) => {
    const arr = localByKey.get(messageIdentityKey(m))
    if (!arr || arr.length === 0) return m
    // An exact-id match is a normal already-synced row: consume it (so a later
    // identical row can't reuse it) and leave it untouched.
    const exactIdx = arr.findIndex((x) => x.id === m.id)
    if (exactIdx !== -1) {
      arr.splice(exactIdx, 1)
      return m
    }
    // Otherwise the first queued local row is this server row's optimistic twin.
    // Keep the server content (canonical urls/blocks); adopt the local id +
    // timestamp so the React key never changes across the re-id.
    const twin = arr.shift()!
    rekeyed = true
    return { ...m, id: twin.id, timestamp: twin.timestamp }
  })
  // Preserve reference identity when nothing was re-keyed: callers rely on
  // `=== snapshot` to skip re-renders when the merge is a no-op.
  const base = rekeyed ? aligned : snapshot

  const baseIds = new Set(base.map((m) => m.id))
  const baseKeys = new Set(base.map(messageIdentityKey))
  const pending = current.filter(
    (m) =>
      m.media &&
      m.media.length > 0 &&
      m.id &&
      now - m.timestamp <= RECONCILE_PRESERVE_MAX_AGE_MS &&
      !baseIds.has(m.id) &&
      !baseKeys.has(messageIdentityKey(m)),
  )
  if (pending.length === 0) return base
  return [...base, ...pending].sort((a, b) => a.timestamp - b.timestamp)
}

// --- Intermediate message persistence (localStorage) ---

const INTERMEDIATE_PREFIX = 'jinn-intermediate-'

export function clearIntermediateMessages(sessionId: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(`${INTERMEDIATE_PREFIX}${sessionId}`)
  } catch { /* ignore */ }
}

/**
 * Remove the engine-only "Attached files:\n- /abs/path" block that the gateway
 * appends to the prompt for the CLI. It must never be shown in the chat bubble —
 * attachments render as chips/thumbnails instead. Safe on text without the block.
 */
export function stripAttachedFilesBlock(text: string): string {
  return text.replace(/\n*Attached files:\n(?:- .*(?:\n|$))+/g, '').trimEnd()
}

// --- Media parsing ---

export function parseMedia(content: string): MediaAttachment[] {
  const media: MediaAttachment[] = []

  // Markdown images: ![alt](url)
  const imgRegex =
    /!\[([^\]]*)\]\((https?:\/\/[^)]+\.(jpg|jpeg|png|gif|webp|svg)(\?[^)]*)?)\)/gi
  let m: RegExpExecArray | null
  while ((m = imgRegex.exec(content)) !== null) {
    media.push({ type: 'image', url: m[2], name: m[1] || 'Image' })
  }

  // Bare image URLs not already captured
  const bareImgRegex =
    /(?<!\]\()https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?\S*)?\b/gi
  while ((m = bareImgRegex.exec(content)) !== null) {
    const url = m[0]
    if (!media.find((x) => x.url === url)) {
      media.push({ type: 'image', url })
    }
  }

  // Audio URLs
  const audioRegex = /https?:\/\/\S+\.(mp3|wav|ogg|m4a|aac)(\?\S*)?\b/gi
  while ((m = audioRegex.exec(content)) !== null) {
    media.push({ type: 'audio', url: m[0], name: m[0].split('/').pop() })
  }

  return media
}
