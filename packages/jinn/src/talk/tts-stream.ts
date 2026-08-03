/**
 * Server-side TTS synthesis for chat read-aloud (POST/GET /api/tts).
 *
 * Validates and bounds request text, synthesizes it either whole or
 * sentence-by-sentence for fast time-to-first-audio, and reports engine
 * readiness. The Kokoro engine is a process-wide singleton so there is
 * exactly one sidecar.
 */
import { createKokoroTts } from "./kokoro.js";
import type { Tts } from "./protocol.js";

type KokoroOpts = Parameters<typeof createKokoroTts>[0];

let engine: Tts | null = null;

/** The shared Kokoro engine (lazily constructed with the live config). */
export function getTalkTts(opts?: KokoroOpts): Tts {
  if (!engine) engine = createKokoroTts(opts);
  return engine;
}

/** Test seam: swap the singleton for a mock. */
export function __setTalkTtsForTest(tts: Tts | null): void {
  engine = tts;
}

/**
 * Max characters accepted by POST /api/tts in a single read-aloud call. Bounds
 * the sidecar's synth time and the WAV response size (≈ a few minutes of audio).
 */
export const TTS_MAX_CHARS = 8000;

/**
 * Validate + bound the `text` field of a POST /api/tts request. Trims, rejects
 * non-strings and empties, and caps over-long input at the last sentence/space
 * boundary before the limit so a word is never cut mid-token. Pure — unit-tested.
 */
export function validateTtsText(
  raw: unknown,
  maxChars = TTS_MAX_CHARS,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "text must be a string" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "text must be a non-empty string" };
  if (trimmed.length <= maxChars) return { ok: true, text: trimmed };
  const head = trimmed.slice(0, maxChars);
  // Prefer a clean cut at a sentence/newline/space boundary in the back half of
  // the window; if none (e.g. one giant token), hard-slice at the cap.
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf(" "));
  const text = (boundary > maxChars / 2 ? head.slice(0, boundary + 1) : head).trim();
  return { ok: true, text };
}

/**
 * Standalone one-shot synthesis for POST /api/tts: returns a single WAV buffer
 * for the whole text. Reuses the shared Kokoro engine; rejects when unavailable.
 */
export async function synthesizeText(text: string, opts?: KokoroOpts): Promise<Buffer> {
  return getTalkTts(opts).synthesize(text);
}

/** TTS engine readiness for GET /api/tts — no synth, no sidecar spawn. */
export function ttsStatus(opts?: KokoroOpts): { available: boolean; voice: string } {
  const s = getTalkTts(opts).status();
  return { available: s.available, voice: s.voice };
}

/**
 * Split already-markdown-stripped prose into sentence-sized chunks for streamed
 * read-aloud. Splits on sentence terminators (followed by whitespace) AND on
 * newlines (list items / paragraphs), collapsing inner whitespace and dropping
 * empties. Pure — unit-tested. Text with no terminator stays one chunk.
 */
export function splitTtsSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/**
 * Synthesize `text` sentence-by-sentence, invoking `onFrame` with each sentence's
 * WAV as soon as it's ready — so the client can PLAY sentence 1 while 2..N are
 * still synthesizing (time-to-first-audio ≈ one sentence, not the whole message).
 *
 * Kokoro is one-request-at-a-time, so synthesis is naturally sequential; that's
 * fine since playback is sequential too. `isCancelled` is checked before and
 * after each synth so a paused/aborted client stops further synthesis promptly
 * (we don't keep synthesizing a message nobody is listening to). Resolves with
 * the number of frames emitted.
 */
export async function streamTtsSentences(
  text: string,
  opts: KokoroOpts | undefined,
  onFrame: (wav: Buffer) => void,
  isCancelled: () => boolean,
): Promise<number> {
  const sentences = splitTtsSentences(text);
  let count = 0;
  for (const sentence of sentences) {
    if (isCancelled()) break;
    const wav = await getTalkTts(opts).synthesize(sentence);
    if (isCancelled()) break;
    onFrame(wav);
    count++;
  }
  return count;
}
