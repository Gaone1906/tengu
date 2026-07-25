import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { InteractiveClaudeEngine } from "../claude-interactive.js";

// claude's auto-compact trigger is a SEPARATE budget from the model's context
// window: it resolves env > settings > server client-data > per-model default,
// and that default sits near 200K even for models whose real window is 1M. Left
// unset, long opus-5 sessions compacted at ~166K — roughly 5x more often than the
// model requires. buildPtyEnv pins the request to 1M; claude clamps it down to the
// model's own max, so smaller-window models (haiku-4-5) are unaffected.

/** buildPtyEnv is private and touches no instance state — reach it off the
 *  prototype so this stays a pure env test with no PTY/proxy setup. */
function buildPtyEnv(proxyPort?: number): Record<string, string> {
  const engine = Object.create(InteractiveClaudeEngine.prototype) as {
    buildPtyEnv(proxyPort?: number, sessionId?: string): Record<string, string>;
  };
  return engine.buildPtyEnv(proxyPort);
}

const ORIGINAL = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
// buildPtyEnv inherits process.env, so an ambient value fails these assertions.
// That is not hypothetical: running the suite from inside a Jinn claude PTY
// exports _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1, which made the
// "no proxy → no first-party assertion" case fail with a bogus '1'. Scrub the
// vars under test so the result depends on buildPtyEnv, not on who ran it.
const ORIGINAL_FIRST_PARTY = process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL;

beforeEach(() => {
  delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = ORIGINAL;
  if (ORIGINAL_FIRST_PARTY === undefined) delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL;
  else process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = ORIGINAL_FIRST_PARTY;
});

describe("claude PTY auto-compact window", () => {
  it("asks for the 1M ceiling by default", () => {
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    expect(buildPtyEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
  });

  it("honours an operator override instead of overwriting it", () => {
    // scrubClaudeCode strips every inherited CLAUDE_CODE_* key, so the override
    // only survives because buildPtyEnv re-reads it off process.env explicitly.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "300000";
    expect(buildPtyEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("300000");
  });

  it("stays within the 100K..1M range claude accepts", () => {
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const value = Number(buildPtyEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(100_000);
    expect(value).toBeLessThanOrEqual(1_000_000);
  });
});

// The window pin above is inert on its own: claude resolves the auto-compact
// budget as min(modelContextWindow, requested). Pointing ANTHROPIC_BASE_URL at
// our loopback SSE proxy fails claude's first-party host check (only literal
// api.anthropic.com passes), which collapses the model window to the 200K
// fallback even for native-1M models — so the clamp silently undid the pin.
describe("claude PTY first-party assertion", () => {
  it("asserts first-party whenever the loopback proxy is in use", () => {
    const env = buildPtyEnv(51234);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:51234");
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
  });

  it("does not assert first-party when no proxy rewrites the base URL", () => {
    const env = buildPtyEnv();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBeUndefined();
  });
});
