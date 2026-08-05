/**
 * TTS engine contract.
 *
 * The shared types and event names for Kokoro speech synthesis, implemented by
 * kokoro.ts and consumed by tts-stream.ts. Nothing else lives here.
 */

import type { GatewayEmit } from "../shared/gateway-events.js"

/** WebSocket event names emitted during synthesis (envelope: { event, payload, ts }). */
export const TALK_EVENTS = {
  audio: "talk:audio",
  ttsDownloadProgress: "talk:tts:download:progress",
  ttsDownloadComplete: "talk:tts:download:complete",
  ttsDownloadError: "talk:tts:download:error",
} as const

/** Broadcast function injected everywhere (matches gateway server's `emit`). */
export type Emit = GatewayEmit

/** Kokoro-82M TTS engine (sidecar-backed). Implemented by kokoro.ts. */
export interface Tts {
  /**
   * Synthesize `text`, sentence-chunked, streaming talk:audio events; resolves
   * with the number of chunks emitted. `seqStart` continues a per-turn monotonic
   * sequence across calls; `final:false` suppresses the `last:true` flag so a
   * turn streamed sentence-by-sentence only signals end-of-audio on the flush.
   */
  speak(sessionId: string, text: string, emit: Emit, opts?: { seqStart?: number; final?: boolean }): Promise<number>
  /**
   * One-shot synthesis of arbitrary `text` into a single WAV buffer (no WS
   * streaming). Backs the standalone POST /api/tts read-aloud surface. Rejects if
   * the engine is unavailable (missing venv/weights).
   */
  synthesize(text: string): Promise<Buffer>
  status(): { available: boolean; downloading: boolean; progress: number; voice: string; ready: boolean }
  /** Pre-spawn the sidecar and load the model so the first real speak is fast. No-op if weights/venv are missing. */
  warm?(): Promise<void>
  /** Download Kokoro weights on first use, emitting talk:tts:download:* events. */
  download(emit: Emit): Promise<void>
  shutdown(): void
}
