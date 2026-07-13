/**
 * Hidden speech-to-text context for the engine.
 *
 * When a submitted chat message carried speech-to-text-derived content, the
 * engine gets a short trusted note that transcription can mangle names, words,
 * and punctuation. The operator-visible message is never touched.
 *
 * `resolveMessageAudiences` is the single split: `visible` (byte-identical to
 * what the operator composed) feeds everything a human ever sees — the persisted
 * transcript row, the queue preview, callbacks, Activity, notifications — while
 * `engine` (note-prefixed, and only when speech-derived) feeds the model dispatch
 * alone. Because the note lives only in the transient `engine` string and is
 * recomputed from the clean text on every request, it never persists and can
 * never be duplicated across a retry, reload, or reconnect.
 */

export const SPEECH_CONTEXT_NOTE =
  "[Voice input note] Part of this message was entered by speech-to-text and may contain " +
  "misheard names or words, missing or wrong punctuation, dropped fragments, or run-together " +
  "sentence boundaries. Infer the intended meaning from the conversation context rather than " +
  "reading it literally.";

export interface MessageAudiences {
  /** Operator-visible text — persisted, previewed, relayed. Never carries the note. */
  visible: string;
  /** Engine-bound text — carries the hidden note exactly once when speech-derived. */
  engine: string;
}

export function resolveMessageAudiences(prompt: string, speechDerived: boolean): MessageAudiences {
  return {
    visible: prompt,
    engine: speechDerived ? `${SPEECH_CONTEXT_NOTE}\n\n${prompt}` : prompt,
  };
}

/**
 * Whether the hidden note may ride the engine prompt for this dispatch.
 *
 * The note is only safe when the prompt is NOT operator-visible. Interactive
 * dispatch bracketed-pastes the prompt into the live PTY/xterm, so a rendered
 * prompt (`promptRendered`) must stay byte-for-byte the operator's text — the
 * note is dropped there rather than leaked. Headless dispatch sends the prompt
 * straight to the model, so the note rides it (exactly once, non-rendered).
 * Notifications (callbacks, relays) never qualify.
 */
export function speechContextApplies(opts: {
  speech: boolean;
  isNotification: boolean;
  promptRendered: boolean;
}): boolean {
  return opts.speech && !opts.isNotification && !opts.promptRendered;
}
