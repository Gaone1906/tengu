/**
 * Jinn Talk — real voice-loop hook (Phase 2).
 *
 * Wires the live loop end to end:
 *   mic → useStt → POST /api/talk/turn → gateway streams talk:* over the WS →
 *   this hook maps events into avatar state, transcript, cards, the parallel-task
 *   tracker, and streamed TTS audio (TalkAudioPlayer drives the orb's level).
 *
 * It REUSES the existing infra rather than rebuilding it:
 *   - useGateway().subscribe — single shared WS; we filter talk:* by sessionId.
 *   - useStt — mic capture + backend STT (handleMicClick / stopRecording / analyser).
 *   - TalkAudioPlayer — sequential low-latency playback of streamed audio chunks.
 *
 * `level` semantics (fed to <AuraAvatar level=…>):
 *   - listening: RMS from the mic analyser (useStt.analyser)
 *   - speaking:  RMS from the audio player's output analyser
 *   - otherwise: undefined → the orb self-animates
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGateway } from "@/hooks/use-gateway"
import { useStt } from "@/hooks/use-stt"
import { api } from "@/lib/api"
import { TalkAudioPlayer } from "./audio-player"
import {
  TALK_EVENTS,
  wireTaskToTracker,
  type TalkAudioEvent,
  type TalkCardDismissEvent,
  type TalkCardEvent,
  type TalkCardUpdateEvent,
  type TalkSayEvent,
  type TalkStateEvent,
  type TalkTaskEvent,
  type TalkTranscriptEvent,
  type TalkTurnDoneEvent,
} from "./protocol"
import type { TranscriptEntry } from "./transcript"
import type { AvatarState, Card, TrackerTask } from "./types"

/** Stable per-surface session id (one Talk view = one logical session). */
export const TALK_SESSION_ID = "talk-main"

export type TtsStatus =
  | { kind: "idle" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string }

export interface UseTalkReturn {
  state: AvatarState
  entries: TranscriptEntry[]
  cards: Card[]
  tasks: TrackerTask[]
  /** 0..1 while listening/speaking, undefined when the orb should self-animate. */
  level: number | undefined
  /** Gateway WS connection state. */
  connected: boolean
  /** True while the mic is actively recording. */
  listening: boolean
  /** Whether backend STT is available (null = still checking). */
  sttAvailable: boolean | null
  /** TTS model readiness / download progress (drives the page hint). */
  ttsStatus: TtsStatus
  /** Start mic capture (also resumes the audio context for output playback). */
  startListening: () => void
  /** Stop everything: cancel mic, drain audio, settle to idle. */
  stop: () => void
}

export function useTalk(sessionId: string = TALK_SESSION_ID): UseTalkReturn {
  const gateway = useGateway()

  const [state, setState] = useState<AvatarState>("idle")
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [tasks, setTasks] = useState<TrackerTask[]>([])
  const [level, setLevel] = useState<number | undefined>(undefined)
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ kind: "idle" })

  // One audio player for the lifetime of the hook.
  const playerRef = useRef<TalkAudioPlayer | null>(null)
  if (!playerRef.current) playerRef.current = new TalkAudioPlayer()

  // rAF handle for the level loop (mic OR output, whichever is active).
  const levelRafRef = useRef<number>(0)
  // Which signal the level loop is currently reading (so repeated starts no-op).
  const levelModeRef = useRef<"mic" | "output" | null>(null)
  // Monotonic counter so a freshly-started turn invalidates stale callbacks.
  const turnSeqRef = useRef(0)

  // STT: feed transcript on auto-stop too (timeout path), but our primary path
  // is the explicit startListening/stop below.
  const stt = useStt()
  const sttRef = useRef(stt)
  sttRef.current = stt

  // ---- Level rAF loop ------------------------------------------------------
  const stopLevelLoop = useCallback(() => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = 0
    }
    levelModeRef.current = null
    setLevel(undefined)
  }, [])

  /** Drive `level` from the mic analyser (listening) or the player (speaking). */
  const startLevelLoop = useCallback((mode: "mic" | "output") => {
    // Already reading this signal — keep the existing rAF running.
    if (levelRafRef.current && levelModeRef.current === mode) return
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
    levelModeRef.current = mode
    const tick = () => {
      if (mode === "mic") {
        const analyser = sttRef.current.analyser
        if (analyser) {
          const buf = new Uint8Array(analyser.fftSize)
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / buf.length)
          setLevel(Math.min(1, rms * 3.2))
        } else {
          setLevel(undefined)
        }
      } else {
        const player = playerRef.current
        if (player && player.playing) {
          setLevel(player.level)
        } else {
          setLevel(undefined)
        }
      }
      levelRafRef.current = requestAnimationFrame(tick)
    }
    levelRafRef.current = requestAnimationFrame(tick)
  }, [])

  // ---- WS subscription: map talk:* → UI state ------------------------------
  useEffect(() => {
    const player = playerRef.current!
    // When the audio queue drains, settle the level loop (turn:done sets idle).
    player.onIdle(() => {
      stopLevelLoop()
    })

    const isOurs = (p: unknown): p is { sessionId: string } =>
      typeof p === "object" && p !== null && (p as { sessionId?: string }).sessionId === sessionId

    // TTS model download is a global, sessionless concern (like stt:download:*),
    // so those frames bypass the per-session filter.
    const GLOBAL_EVENTS = new Set<string>([
      TALK_EVENTS.ttsDownloadProgress,
      TALK_EVENTS.ttsDownloadComplete,
      TALK_EVENTS.ttsDownloadError,
    ])

    const unsub = gateway.subscribe((event: string, payload: unknown) => {
      if (!event.startsWith("talk:")) return
      if (!GLOBAL_EVENTS.has(event) && !isOurs(payload)) return

      switch (event) {
        case TALK_EVENTS.state: {
          setState((payload as TalkStateEvent).state)
          break
        }
        case TALK_EVENTS.transcript: {
          // User caption — replace any in-flight user entry for this turn.
          const text = (payload as TalkTranscriptEvent).text
          setEntries((prev) => {
            const next = prev.filter((e) => e.id !== "user")
            return [{ id: "user", role: "user", text }, ...next]
          })
          break
        }
        case TALK_EVENTS.say: {
          // Assistant reply text — append/extend the single assistant entry so
          // the transcript shows exactly what's being spoken.
          const ev = payload as TalkSayEvent
          setEntries((prev) => {
            const existing = prev.find((e) => e.id === "assistant")
            // Each say chunk is a sentence; join with a space when the previous
            // chunk didn't already end in whitespace so words don't run together.
            const sep = existing && !/\s$/.test(existing.text) ? " " : ""
            const merged = existing ? existing.text + sep + ev.text : ev.text
            const without = prev.filter((e) => e.id !== "assistant")
            return [
              ...without,
              { id: "assistant", role: "assistant", text: merged, partial: !ev.final },
            ]
          })
          break
        }
        case TALK_EVENTS.audio: {
          const ev = payload as TalkAudioEvent
          player.enqueue(ev.seq, ev.mime, ev.dataBase64)
          // First audio → ensure we're showing the speaking visual and reading
          // the output analyser for the orb level.
          setState((s) => (s === "speaking" ? s : "speaking"))
          startLevelLoop("output")
          break
        }
        case TALK_EVENTS.card: {
          const card = (payload as TalkCardEvent).card
          setCards((prev) => {
            const without = prev.filter((c) => c.id !== card.id)
            return [...without, card]
          })
          break
        }
        case TALK_EVENTS.cardUpdate: {
          const ev = payload as TalkCardUpdateEvent
          setCards((prev) =>
            prev.map((c) => (c.id === ev.cardId ? ({ ...c, ...ev.patch } as Card) : c)),
          )
          break
        }
        case TALK_EVENTS.cardDismiss: {
          const ev = payload as TalkCardDismissEvent
          setCards((prev) => prev.filter((c) => c.id !== ev.cardId))
          break
        }
        case TALK_EVENTS.cardClear: {
          setCards([])
          break
        }
        case TALK_EVENTS.task: {
          const task = wireTaskToTracker((payload as TalkTaskEvent).task)
          setTasks((prev) => {
            const idx = prev.findIndex((t) => t.id === task.id)
            if (idx === -1) return [...prev, task]
            const next = prev.slice()
            next[idx] = task
            return next
          })
          break
        }
        case TALK_EVENTS.turnDone: {
          // turn:done carries { ok, error? } — we settle the same way either
          // way (the transcript already shows whatever the backend streamed).
          void (payload as TalkTurnDoneEvent)
          // Mark the assistant entry final (no streaming cursor).
          setEntries((prev) =>
            prev.map((e) => (e.id === "assistant" ? { ...e, partial: false } : e)),
          )
          // If audio is still draining, the player's onIdle will settle level;
          // otherwise settle now.
          if (!player.playing) {
            setState("idle")
            stopLevelLoop()
          } else {
            setState("speaking")
          }
          break
        }
        case TALK_EVENTS.ttsDownloadProgress: {
          const p = (payload as { progress?: number }).progress ?? 0
          setTtsStatus({ kind: "downloading", progress: p })
          break
        }
        case TALK_EVENTS.ttsDownloadComplete: {
          setTtsStatus({ kind: "ready" })
          break
        }
        case TALK_EVENTS.ttsDownloadError: {
          const msg = (payload as { error?: string }).error ?? "TTS download failed"
          setTtsStatus({ kind: "error", message: msg })
          break
        }
      }
    })

    return () => {
      unsub()
    }
  }, [gateway, sessionId, startLevelLoop, stopLevelLoop])

  // ---- Pre-warm the agent session -----------------------------------------
  // Boot the persistent Agent-SDK session (and its CLI subprocess) on mount so
  // the user's FIRST utterance is warm (~1.5s) instead of paying the ~9s cold
  // boot. Fire-and-forget; harmless if it races with the first real turn.
  useEffect(() => {
    api.talkWarm(sessionId).catch(() => {
      /* warm is best-effort — the first turn will just boot lazily */
    })
  }, [sessionId])

  // ---- Initial TTS status probe -------------------------------------------
  useEffect(() => {
    let alive = true
    api
      .talkStatus()
      .then((s) => {
        if (!alive) return
        if (s.downloading) setTtsStatus({ kind: "downloading", progress: s.progress ?? 0 })
        else if (s.ttsAvailable) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "idle" })
      })
      .catch(() => {
        /* status endpoint optional — leave idle */
      })
    return () => {
      alive = false
    }
  }, [])

  // ---- Mic control ---------------------------------------------------------
  const startListening = useCallback(() => {
    const player = playerRef.current
    // First user gesture: unlock/resume the output AudioContext for playback.
    player?.resume()
    setState("listening")
    setEntries([]) // fresh exchange
    startLevelLoop("mic")
    void sttRef.current.handleMicClick()
  }, [startLevelLoop])

  const stop = useCallback(async () => {
    turnSeqRef.current++
    const seq = turnSeqRef.current
    const s = sttRef.current
    if (s.state === "recording") {
      setState("thinking")
      const text = await s.stopRecording()
      if (turnSeqRef.current !== seq) return // superseded by a newer turn
      if (text && text.trim()) {
        setEntries([{ id: "user", role: "user", text }])
        try {
          await api.talkTurn(sessionId, text)
          // From here the gateway streams talk:* — handled by the subscription.
        } catch {
          setState("idle")
          stopLevelLoop()
        }
      } else {
        setState("idle")
        stopLevelLoop()
      }
    } else {
      // Not recording — just settle and drain any audio.
      s.cancelRecording()
      playerRef.current?.reset()
      setState("idle")
      stopLevelLoop()
    }
  }, [sessionId, stopLevelLoop])

  // ---- Cleanup -------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  const listening = stt.state === "recording"

  return useMemo(
    () => ({
      state,
      entries,
      cards,
      tasks,
      level,
      connected: gateway.connected,
      listening,
      sttAvailable: stt.available,
      ttsStatus,
      startListening,
      stop,
    }),
    [
      state,
      entries,
      cards,
      tasks,
      level,
      gateway.connected,
      listening,
      stt.available,
      ttsStatus,
      startListening,
      stop,
    ],
  )
}
