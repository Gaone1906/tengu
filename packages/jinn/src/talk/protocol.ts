/**
 * Jinn Talk — backend protocol (Phase 2, real e2e voice loop).
 *
 * Canonical types shared by the /talk Agent-SDK turn, the tool dispatcher, the
 * Kokoro TTS sidecar, and the HTTP/WS plumbing. The card shapes MUST stay 1:1
 * with the frontend renderer in packages/web/src/routes/talk/types.ts — the
 * agent's show_card tool input is exactly this union.
 */

export type TalkState = "idle" | "listening" | "thinking" | "speaking"
export type JobStatus = "queued" | "running" | "done" | "error"

// ---------------------------------------------------------------------------
// Content cards — 1:1 mirror of web/src/routes/talk/types.ts `Card`.
// ---------------------------------------------------------------------------
export interface CardBase {
  id: string
  title?: string
  badge?: string
}
export interface TextCard extends CardBase { type: "text"; body: string; tldr?: string }
export interface StatCard extends CardBase {
  type: "stat"; value: string; label: string
  delta?: { dir: "up" | "down" | "flat"; value: string }
}
export interface ListCard extends CardBase {
  type: "list"; ordered?: boolean; items: Array<{ text: string; done?: boolean }>
}
export interface ImageCard extends CardBase { type: "image"; src: string; alt?: string; caption?: string }
export interface ImageGridCard extends CardBase { type: "image-grid"; images: Array<{ src: string; alt?: string }> }
export interface StatusCard extends CardBase {
  type: "status"; label: string; progress: number; state: JobStatus; chips?: string[]
}
export interface AgentActivity {
  id: string; name: string; role: string; status: JobStatus; detail?: string; progress?: number
}
export interface AgentActivityCard extends CardBase { type: "agent-activity"; agents: AgentActivity[] }
export interface LinkCard extends CardBase { type: "link"; url: string; label: string; source?: string }

export type Card =
  | TextCard | StatCard | ListCard | ImageCard
  | ImageGridCard | StatusCard | AgentActivityCard | LinkCard

export interface TrackerTask {
  id: string
  label: string
  owner: string
  status: JobStatus
  progress?: number
  result?: string
}

// ---------------------------------------------------------------------------
// WebSocket events broadcast to web clients (envelope: { event, payload, ts }).
// Names are the single source of truth — frontend mirrors these.
// ---------------------------------------------------------------------------
export const TALK_EVENTS = {
  state: "talk:state",
  transcript: "talk:transcript",
  say: "talk:say",
  audio: "talk:audio",
  card: "talk:card",
  cardUpdate: "talk:card:update",
  cardDismiss: "talk:card:dismiss",
  cardClear: "talk:card:clear",
  task: "talk:task",
  turnDone: "talk:turn:done",
  ttsDownloadProgress: "talk:tts:download:progress",
  ttsDownloadComplete: "talk:tts:download:complete",
  ttsDownloadError: "talk:tts:download:error",
} as const

export interface TalkStateEvent { sessionId: string; state: TalkState }
export interface TalkTranscriptEvent { sessionId: string; role: "user"; text: string }
/** A chunk of the assistant's spoken reply (also what TTS voices). */
export interface TalkSayEvent { sessionId: string; text: string; final?: boolean }
/** One sentence-level TTS audio chunk, base64-encoded, ordered by seq. */
export interface TalkAudioEvent { sessionId: string; seq: number; mime: string; dataBase64: string; last?: boolean }
export interface TalkCardEvent { sessionId: string; card: Card }
export interface TalkCardUpdateEvent { sessionId: string; cardId: string; patch: Partial<Card> }
export interface TalkCardDismissEvent { sessionId: string; cardId: string }
export interface TalkCardClearEvent { sessionId: string }
export interface TalkTaskEvent { sessionId: string; task: TrackerTask }
export interface TalkTurnDoneEvent { sessionId: string; ok: boolean; error?: string }

// ---------------------------------------------------------------------------
// HTTP request/response shapes.
// ---------------------------------------------------------------------------
export interface TalkTurnRequest { sessionId: string; text: string }
export interface TalkTurnResponse { ok: boolean; error?: string }
export interface TalkTtsRequest { text: string; voice?: string }
export interface TalkStatusResponse {
  ttsAvailable: boolean
  ttsDownloading: boolean
  progress: number
  voice: string
  ready: boolean
}

/** Broadcast function injected everywhere (matches gateway server's `emit`). */
export type Emit = (event: string, payload: unknown) => void
