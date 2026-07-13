import { describe, it, expect } from "vitest";
import { resolveMessageAudiences, speechContextApplies, SPEECH_CONTEXT_NOTE } from "../speech-context.js";

/**
 * The speech-context split has one job: give the engine a hidden note when a
 * submitted message carried speech-to-text content, while the operator-visible
 * text stays byte-identical. Every visible/persisted/queued/callback/Activity
 * consumer is fed `visible`; only `dispatchWebSessionRun` is fed `engine`.
 */
describe("resolveMessageAudiences", () => {
  it("leaves a typed-only message identical for both audiences", () => {
    const { visible, engine } = resolveMessageAudiences("book the room", false);
    expect(visible).toBe("book the room");
    expect(engine).toBe("book the room");
    expect(engine).not.toContain(SPEECH_CONTEXT_NOTE);
  });

  it("keeps the visible text clean when the message is speech-derived", () => {
    // Non-render / non-persistence: the note must never reach the transcript
    // row, queue preview, callbacks, or Activity — all of which read `visible`.
    const { visible } = resolveMessageAudiences("call the vendor at nine", true);
    expect(visible).toBe("call the vendor at nine");
    expect(visible).not.toContain(SPEECH_CONTEXT_NOTE);
  });

  it("prepends the hidden context note to the engine text when speech-derived", () => {
    const { engine } = resolveMessageAudiences("call the vendor at nine", true);
    expect(engine).toContain(SPEECH_CONTEXT_NOTE);
    expect(engine.endsWith("call the vendor at nine")).toBe(true);
  });

  it("injects the note exactly once (no duplication across re-derivation)", () => {
    // Retry / reload / reconnect all re-derive from the SAME clean operator
    // text, so the note count is always exactly one, never accumulating.
    const first = resolveMessageAudiences("hello there", true);
    const occurrences = first.engine.split(SPEECH_CONTEXT_NOTE).length - 1;
    expect(occurrences).toBe(1);

    // Feeding the clean visible text back through the transform still yields one.
    const again = resolveMessageAudiences(first.visible, true);
    expect(again.engine.split(SPEECH_CONTEXT_NOTE).length - 1).toBe(1);
    expect(again.engine).toBe(first.engine);
  });

  it("describes transcription imperfections and defers meaning to context", () => {
    expect(SPEECH_CONTEXT_NOTE).toMatch(/speech-to-text/i);
    expect(SPEECH_CONTEXT_NOTE).toMatch(/context/i);
  });
});

describe("speechContextApplies", () => {
  it("attaches the note for a headless speech-derived user message", () => {
    expect(speechContextApplies({ speech: true, isNotification: false, promptRendered: false })).toBe(true);
  });

  it("never attaches the note for typed-only or notification messages", () => {
    expect(speechContextApplies({ speech: false, isNotification: false, promptRendered: false })).toBe(false);
    expect(speechContextApplies({ speech: true, isNotification: true, promptRendered: false })).toBe(false);
  });

  it("suppresses the note when the prompt is rendered into a PTY/xterm", () => {
    // Interactive dispatch bracketed-pastes the prompt into the operator-visible
    // terminal, so the note must NOT ride the prompt there.
    expect(speechContextApplies({ speech: true, isNotification: false, promptRendered: true })).toBe(false);
  });

  it("keeps the PTY prompt byte-for-byte clean while headless gets the note once", () => {
    const dictated = "call the vendor at nine";

    // Interactive (rendered) dispatch: engine text === the operator's visible text.
    const pty = resolveMessageAudiences(
      dictated,
      speechContextApplies({ speech: true, isNotification: false, promptRendered: true }),
    );
    expect(pty.engine).toBe(dictated);
    expect(pty.engine).not.toContain(SPEECH_CONTEXT_NOTE);

    // Headless dispatch: engine text carries the hidden note exactly once.
    const headless = resolveMessageAudiences(
      dictated,
      speechContextApplies({ speech: true, isNotification: false, promptRendered: false }),
    );
    expect(headless.engine.split(SPEECH_CONTEXT_NOTE).length - 1).toBe(1);
    expect(headless.engine.endsWith(dictated)).toBe(true);
  });
});
