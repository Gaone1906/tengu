/**
 * Jinn Talk — /talk route (Concept AURA).
 *
 * A full-screen, Jarvis-style voice surface layered on top of the COO: the
 * living liquid-light orb (4 states + springy transitions), the dynamic
 * "Lego-block" content cards, a parallel-task tracker, and a minimal transcript.
 *
 * PHASE 1 = visual-first proof of concept. The voice loop is SCRIPTED (see
 * demo-script.ts) and TTS uses the Web Speech API (see use-speak.ts). The mic
 * button reuses the existing useStt hook for trigger UX; backend STT is
 * best-effort and the demo works without it.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Mic, Play, Sun, Moon, Square } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStt } from "@/hooks/use-stt"
import { useTheme } from "@/routes/providers"
import { AuraAvatar } from "./aura-avatar"
import { CardStack } from "./cards/card-stack"
import { Transcript, type TranscriptEntry } from "./transcript"
import { TaskTracker } from "./task-tracker"
import { useSpeak } from "./use-speak"
import { runDemo } from "./demo-script"
import type { AvatarState, Card, TrackerTask } from "./types"

const STATES: AvatarState[] = ["idle", "listening", "thinking", "speaking"]

export default function TalkPage() {
  const [state, setState] = useState<AvatarState>("idle")
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [tasks, setTasks] = useState<TrackerTask[]>([])
  /** Live mic amplitude 0..1, or undefined → avatar self-animates. */
  const [level, setLevel] = useState<number | undefined>(undefined)

  const { theme, setTheme } = useTheme()
  const speakHandle = useSpeak()
  const speakRef = useRef(speakHandle)
  speakRef.current = speakHandle

  const cancelDemoRef = useRef<(() => void) | null>(null)
  const utteranceSeq = useRef(0)

  const stopDemo = useCallback(() => {
    cancelDemoRef.current?.()
    cancelDemoRef.current = null
  }, [])

  // --- STT (mic trigger UX only; backend is best-effort for this POC) -------
  const handleUtterance = useCallback((text: string) => {
    const seq = ++utteranceSeq.current
    const userId = `u-${seq}`
    setEntries([{ id: userId, role: "user", text }])
    setState("thinking")
    window.setTimeout(() => {
      if (utteranceSeq.current !== seq) return
      const reply = "Got it — pulling that together now."
      setState("speaking")
      setEntries([
        { id: userId, role: "user", text },
        { id: `a-${seq}`, role: "assistant", text: reply },
      ])
      speakRef.current
        .speak(reply)
        .then(() => { if (utteranceSeq.current === seq) setState("idle") })
        .catch(() => {})
    }, 1200)
  }, [])

  const stt = useStt(undefined, handleUtterance)

  // Reflect recording → listening, and feed the analyser amplitude to the orb.
  useEffect(() => {
    if (stt.state === "recording") setState("listening")
  }, [stt.state])

  useEffect(() => {
    const analyser = stt.analyser
    if (!analyser) {
      setLevel(undefined)
      return
    }
    const buf = new Uint8Array(analyser.fftSize)
    let raf = 0
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / buf.length)
      // Scale RMS into a lively 0..1 range for the visuals.
      setLevel(Math.min(1, rms * 3.2))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [stt.analyser])

  const onMic = useCallback(async () => {
    stopDemo()
    if (stt.state === "recording") {
      const text = await stt.stopRecording()
      if (text) handleUtterance(text)
      else setState("idle")
      return
    }
    setState("listening")
    stt.handleMicClick()
  }, [stt, stopDemo, handleUtterance])

  // --- Manual state scrubbing (lets a reviewer feel each state) -------------
  const onPickState = useCallback((s: AvatarState) => {
    stopDemo()
    speakRef.current.cancel()
    setState(s)
    if (s === "idle") {
      setEntries([])
      setCards([])
    }
  }, [stopDemo])

  const onPlayDemo = useCallback(() => {
    stopDemo()
    speakRef.current.cancel()
    cancelDemoRef.current = runDemo({
      setState,
      setEntries,
      setCards,
      setTasks,
      speak: (text) => speakRef.current.speak(text),
    })
  }, [stopDemo])

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      cancelDemoRef.current?.()
      speakRef.current.cancel()
    }
  }, [])

  const isRecording = stt.state === "recording"

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

          {/* Mic — reuses useStt */}
          <button
            onClick={onMic}
            aria-label={isRecording ? "Stop recording" : "Start voice input"}
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-full transition-all duration-200",
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

        {/* Subtle hint when STT model isn't installed */}
        {stt.available === false && (
          <p className="mt-2 text-center text-caption1 text-[var(--text-quaternary)]">
            STT model not installed — mic shows the listening visual only
          </p>
        )}
      </div>
    </div>
  )
}
