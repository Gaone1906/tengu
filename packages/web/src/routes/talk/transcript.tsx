/**
 * Jinn Talk — Transcript (Concept AURA).
 *
 * A minimal, Jarvis-like caption/reply overlay that floats centered over the
 * orb (upper area). It shows only the most recent exchange — one user caption
 * and one assistant reply — so it never becomes a scroll. The latest assistant
 * line reveals word-by-word with a blur-in (each word eases from
 * opacity:0 + blur(6px) + translateY → settled, staggered ~65ms), exactly like
 * the prototype's `speak()` reveal. A soft blinking cursor trails a `partial`
 * reply that is still streaming.
 *
 * Non-blocking by design (pointer-events:none) and themed entirely from Ledger
 * tokens. Honors prefers-reduced-motion (instant, no blur — see tracker.css).
 */
import { useMemo } from "react"
import type { CSSProperties, JSX } from "react"
import { EASING } from "./motion"
import "./tracker.css"

/**
 * One line of the live transcript. Defined here (the lead imports it from this
 * module). `partial` marks an assistant reply that is still streaming.
 */
export interface TranscriptEntry {
  id: string
  role: "user" | "assistant"
  text: string
  partial?: boolean
}

export interface TranscriptProps {
  entries: TranscriptEntry[]
  className?: string
}

/** Expose the canonical easing curves to the stylesheet once, at the root. */
const EASE_VARS: CSSProperties = {
  ["--ease-spring" as string]: EASING.spring,
  ["--ease-smooth" as string]: EASING.smooth,
  ["--ease-snappy" as string]: EASING.snappy,
}

/** Split into word spans whose stagger index drives the blur-in delay. */
function WordReveal({ text }: { text: string }) {
  // Preserve single spaces between words; collapse runs but keep content.
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text])
  return (
    <>
      {words.map((word, i) => (
        // The space MUST live outside the span: the word span is
        // display:inline-block, and browsers trim trailing whitespace inside
        // an inline-block box — so a space kept inside collapses and the words
        // run together. Emitting it as a sibling text node preserves it.
        // eslint-disable-next-line react/no-array-index-key
        <span key={i} style={{ ["--i" as string]: i }}>
          <span className="transcript__word" style={{ ["--i" as string]: i }}>
            {word}
          </span>
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  )
}

export function Transcript({ entries, className }: TranscriptProps): JSX.Element {
  // Keep only the most recent user line and the most recent assistant line.
  const { user, assistant } = useMemo(() => {
    let user: TranscriptEntry | undefined
    let assistant: TranscriptEntry | undefined
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (!assistant && e.role === "assistant") assistant = e
      else if (!user && e.role === "user") user = e
      if (user && assistant) break
    }
    return { user, assistant }
  }, [entries])

  return (
    <div
      className={`transcript${className ? ` ${className}` : ""}`}
      style={EASE_VARS}
      aria-live="polite"
    >
      {user ? (
        // Keyed on id so a new user line re-plays its slide+fade enter.
        <p className="transcript__caption" key={user.id}>
          {user.text}
        </p>
      ) : null}

      {assistant ? (
        <p className="transcript__reply">
          {/* Keyed on id+text so streaming updates remount the word run and
              the blur-in reveal re-fires for the freshly appended words. */}
          <WordReveal
            key={`${assistant.id}:${assistant.text}`}
            text={assistant.text}
          />
          {assistant.partial ? (
            <span className="transcript__cursor" aria-hidden="true" />
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
