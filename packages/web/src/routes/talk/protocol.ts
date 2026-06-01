/**
 * Jinn Talk — frontend protocol (Phase 2 real loop).
 *
 * Mirrors packages/jinn/src/talk/protocol.ts. The WS event names + payloads are
 * the contract between the gateway and the real-loop hook (use-talk.ts). Card is
 * reused verbatim from ./types (the renderer's input). The wire task uses
 * `label` (backend set_task); we map it to the renderer's `TrackerTask.title`.
 */
import type { Card, TrackerTask, AvatarState } from "./types"

export type { Card, TrackerTask }
export type TalkState = AvatarState // idle | listening | thinking | speaking

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

/** Task as it arrives on the wire (backend uses `label`). */
export interface WireTask {
  id: string
  label: string
  owner: string
  status: "queued" | "running" | "done" | "error"
  progress?: number
  result?: string
}

/** Map a wire task to the renderer's TrackerTask (label → title). */
export function wireTaskToTracker(t: WireTask): TrackerTask {
  return { id: t.id, title: t.label, owner: t.owner, status: t.status, progress: t.progress, result: t.result }
}

export interface TalkStateEvent { sessionId: string; state: TalkState }
export interface TalkTranscriptEvent { sessionId: string; role: "user"; text: string }
export interface TalkSayEvent { sessionId: string; text: string; final?: boolean }
export interface TalkAudioEvent { sessionId: string; seq: number; mime: string; dataBase64: string; last?: boolean }
export interface TalkCardEvent { sessionId: string; card: Card }
export interface TalkCardUpdateEvent { sessionId: string; cardId: string; patch: Partial<Card> }
export interface TalkCardDismissEvent { sessionId: string; cardId: string }
export interface TalkCardClearEvent { sessionId: string }
export interface TalkTaskEvent { sessionId: string; task: WireTask }
export interface TalkTurnDoneEvent { sessionId: string; ok: boolean; error?: string }
