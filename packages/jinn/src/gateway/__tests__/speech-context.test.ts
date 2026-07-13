import { describe, it, expect } from "vitest";
import { resolveMessageAudiences, SPEECH_CONTEXT_NOTE } from "../speech-context.js";

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
