import { describe, it, expect } from "vitest";
import { TurnResolver } from "../claude-interactive.js";

/**
 * Context compaction (docs/tengu/03-implementation-plan.md step 7). Claude
 * Code fires SessionStart again with `source: "compact"` when a `/compact`
 * turn actually replaces the conversation with a summary — TurnResolver must
 * surface that source on the settled EngineResult so
 * sessions/compaction.ts's re-injection decision is driven by a real signal,
 * not an assumption that `/compact` always succeeds.
 */

function probe(r: TurnResolver) {
  let value: import("../../shared/types.js").EngineResult | undefined;
  void r.promise.then((v) => { value = v; });
  return () => value;
}

describe("TurnResolver — SessionStart source", () => {
  it("surfaces source:\"compact\" on the settled EngineResult", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", native: true });
    const get = probe(r);

    r.onHook({ hook_event_name: "SessionStart", session_id: "sid", source: "compact" });
    expect(r.sessionStartSource).toBe("compact");

    r.onHook({ hook_event_name: "Stop", session_id: "sid", last_assistant_message: "" });
    await Promise.resolve();

    expect(get()?.sessionStartSource).toBe("compact");
  });

  it("leaves sessionStartSource undefined for an ordinary startup/resume turn", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", native: true });
    const get = probe(r);

    r.onHook({ hook_event_name: "SessionStart", session_id: "sid", source: "resume" });
    r.onHook({ hook_event_name: "Stop", session_id: "sid", last_assistant_message: "" });
    await Promise.resolve();

    expect(get()?.sessionStartSource).toBe("resume");
    expect(get()?.sessionStartSource).not.toBe("compact");
  });

  it("stays undefined when the hook carries no source at all (assumeStarted warm-PTY reuse)", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, native: true });
    const get = probe(r);

    r.onHook({ hook_event_name: "Stop", session_id: "sid", last_assistant_message: "" });
    await Promise.resolve();

    expect(get()?.sessionStartSource).toBeUndefined();
  });
});
