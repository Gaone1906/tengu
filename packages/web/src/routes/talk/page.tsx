/**
 * Jinn Talk — /talk route (Concept AURA).
 *
 * A full-screen, Jarvis-style voice surface layered on top of the COO: the
 * living liquid-light orb (4 states + springy transitions), the dynamic
 * "Lego-block" content cards, a parallel-task tracker, and a minimal transcript.
 *
 * PHASE 2 = the REAL voice loop is the default (see use-talk.ts): mic → STT →
 * POST /api/talk/turn → the gateway streams talk:* events (state, transcript,
 * say, audio, cards, tasks) back over the WS, which this page renders live.
 * Streamed TTS audio drives the orb's level via TalkAudioPlayer.
 *
 * The Phase-1 SCRIPTED demo (demo-script.ts + Web Speech useSpeak) is preserved
 * behind a "Demo" toggle in the dock — handy for a deterministic walkthrough.
 * When demo mode is on, the live WS loop is paused (events ignored).
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Mic, Play, Sun, Moon, Square, Sparkles, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { useTheme } from "@/routes/providers"
import { AuraAvatar } from "./aura-avatar"
import { CardStack } from "./cards/card-stack"
import { Transcript, type TranscriptEntry } from "./transcript"
import { TaskTracker } from "./task-tracker"
import { useSpeak } from "./use-speak"
import { useTalk } from "./use-talk"
import { runDemo } from "./demo-script"
import type { AvatarState, Card, TrackerTask } from "./types"

const STATES: AvatarState[] = ["idle", "listening", "thinking", "speaking"]

export default function TalkPage() {
  const { theme, setTheme } = useTheme()

  // --- The REAL loop (default) ---------------------------------------------
  const talk = useTalk()

  // --- Demo mode (Phase-1 scripted walkthrough, paused live loop) ----------
  const [demoMode, setDemoMode] = useState(false)
  const speakHandle = useSpeak()
  const speakRef = useRef(speakHandle)
  speakRef.current = speakHandle
  const cancelDemoRef = useRef<(() => void) | null>(null)

  // Demo-local UI state (kept separate so it never collides with live state).
  const [demoState, setDemoState] = useState<AvatarState>("idle")
  const [demoEntries, setDemoEntries] = useState<TranscriptEntry[]>([])
  const [demoCards, setDemoCards] = useState<Card[]>([])
  const [demoTasks, setDemoTasks] = useState<TrackerTask[]>([])

  const stopDemo = useCallback(() => {
    cancelDemoRef.current?.()
    cancelDemoRef.current = null
    speakRef.current.cancel()
  }, [])

  // What the page actually renders: demo state when in demo mode, else live.
  const state = demoMode ? demoState : talk.state
  const entries = demoMode ? demoEntries : talk.entries
  const cards = demoMode ? demoCards : talk.cards
  const tasks = demoMode ? demoTasks : talk.tasks
  const level = demoMode ? undefined : talk.level

  // --- Mic (live loop) ------------------------------------------------------
  const onMic = useCallback(() => {
    if (demoMode) return
    if (talk.listening) talk.stop()
    else talk.startListening()
  }, [demoMode, talk])

  // --- Manual state scrubbing (lets a reviewer feel each state) -------------
  // Scrubbing is a visual preview, so it flips into demo mode (which pauses the
  // live WS loop) and sets that orb state. This keeps the live loop's real
  // state untouched while still letting a reviewer feel each mood.
  const onPickState = useCallback(
    (s: AvatarState) => {
      if (!demoMode && talk.listening) talk.stop()
      stopDemo()
      setDemoMode(true)
      setDemoState(s)
      if (s === "idle") {
        setDemoEntries([])
        setDemoCards([])
        setDemoTasks([])
      }
    },
    [demoMode, stopDemo, talk],
  )

  const onPlayDemo = useCallback(() => {
    setDemoMode(true)
    if (talk.listening) talk.stop()
    stopDemo()
    cancelDemoRef.current = runDemo({
      setState: setDemoState,
      setEntries: setDemoEntries,
      setCards: setDemoCards,
      setTasks: setDemoTasks,
      speak: (text) => speakRef.current.speak(text),
    })
  }, [stopDemo, talk])

  const onToggleDemo = useCallback(() => {
    setDemoMode((prev) => {
      const next = !prev
      if (next) {
        // Entering demo: pause the live loop's mic.
        if (talk.listening) talk.stop()
      } else {
        // Leaving demo: stop the scripted run + reset demo visuals.
        stopDemo()
        setDemoState("idle")
        setDemoEntries([])
        setDemoCards([])
        setDemoTasks([])
      }
      return next
    })
  }, [stopDemo, talk])

  // Clean up the demo on unmount.
  useEffect(() => {
    return () => {
      cancelDemoRef.current?.()
      speakRef.current.cancel()
    }
  }, [])

  const isRecording = !demoMode && talk.listening

  // Status hint shown under the dock.
  const hint = (() => {
    if (demoMode) return null
    if (!talk.connected) return "Connecting to Jinn…"
    if (talk.ttsStatus.kind === "downloading")
      return `Voice model downloading… ${Math.round(talk.ttsStatus.progress)}%`
    if (talk.ttsStatus.kind === "error") return `Voice: ${talk.ttsStatus.message}`
    if (talk.sttAvailable === false)
      return "STT model not installed — mic shows the listening visual only"
    return null
  })()

  return (
    <div
      data-state={state}
      className="relative h-dvh w-full overflow-hidden"
      style={{
        background:
          "radial-gradient(125% 125% at 50% 36%, var(--bg-tertiary) 0%, var(--bg) 58%, var(--bg) 100%)",
        color: "var(--text-primary)",
      }}
    >
      {/* Top-left wordmark */}
      <div className="pointer-events-none absolute left-7 top-6 select-none font-[family-name:var(--font-code)] text-xs uppercase tracking-[0.3em] text-[var(--text-tertiary)]">
        Jinn · Talk&nbsp;&nbsp;<span className="text-[var(--accent)]">// AURA</span>
        {demoMode ? <span className="ml-2 text-[var(--text-quaternary)]">· demo</span> : null}
      </div>

      {/* Back to dock */}
      <Link
        to="/"
        aria-label="Back to Jinn"
        className="absolute right-6 top-6 z-30 inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-3.5 text-footnote text-[var(--text-secondary)] backdrop-blur-md transition-colors hover:text-[var(--text-primary)]"
      >
        <ArrowLeft size={15} /> Dock
      </Link>

      {/* Parallel-task tracker (top-right, below the back button) */}
      {tasks.length > 0 && (
        <div className="absolute right-6 top-20 z-20">
          <TaskTracker tasks={tasks} />
        </div>
      )}

      {/* Transcript overlay (upper-center) */}
      <div className="pointer-events-none absolute inset-x-0 top-[13%] z-20 flex justify-center px-6">
        <Transcript entries={entries} />
      </div>

      {/* The hero orb, dead center */}
      <div className="absolute inset-0 grid place-items-center">
        <AuraAvatar state={state} level={level} size={360} />
      </div>

      {/* Composed content cards (lower third) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[20%] z-20">
        <CardStack cards={cards} />
      </div>

      {/* Control dock */}
      <div className="absolute bottom-8 left-1/2 z-30 -translate-x-1/2">
        <div className="flex items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl">
          {STATES.map((s) => (
            <button
              key={s}
              onClick={() => onPickState(s)}
              className={cn(
                "rounded-full px-3.5 py-2 text-footnote capitalize transition-all duration-200",
                state === s
                  ? "bg-[var(--accent)] font-semibold text-[var(--accent-contrast)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              {s}
            </button>
          ))}

          <div className="mx-1 h-5 w-px bg-[var(--separator)]" />

          {/* Mic — drives the live loop (disabled in demo mode) */}
          <button
            onClick={onMic}
            disabled={demoMode}
            aria-label={isRecording ? "Stop recording" : "Start voice input"}
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-full transition-all duration-200",
              demoMode && "opacity-40",
              isRecording
                ? "bg-[var(--system-red)] text-white"
                : "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
            )}
          >
            {isRecording ? <Square size={15} className="fill-current" /> : <Mic size={17} />}
          </button>

          {/* Play scripted demo */}
          <button
            onClick={onPlayDemo}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-2 text-footnote font-semibold text-[var(--accent-contrast)] transition-all duration-200 hover:brightness-110"
          >
            <Play size={14} className="fill-current" /> Play demo
          </button>

          {/* Demo / Live toggle */}
          <button
            onClick={onToggleDemo}
            aria-pressed={demoMode}
            aria-label={demoMode ? "Switch to live voice loop" : "Switch to scripted demo"}
            title={demoMode ? "Demo mode — live loop paused" : "Live mode"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-footnote transition-all duration-200",
              demoMode
                ? "bg-[var(--fill-secondary)] font-semibold text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
            )}
          >
            {demoMode ? <Sparkles size={14} /> : <Radio size={14} />}
            {demoMode ? "Demo" : "Live"}
          </button>

          <div className="mx-1 h-5 w-px bg-[var(--separator)]" />

          {/* Theme toggle (handy for reviewing both Ledger themes) */}
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label="Toggle theme"
            className="inline-flex size-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-all duration-200 hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>

        {/* Connection / model status hint */}
        {hint && (
          <p className="mt-2 text-center text-caption1 text-[var(--text-quaternary)]">{hint}</p>
        )}
      </div>
    </div>
  )
}
