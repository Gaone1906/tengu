import { describe, it, expect, afterEach } from "vitest";
import { InteractiveClaudeEngine } from "../claude-interactive.js";

// claude's auto-compact trigger is a SEPARATE budget from the model's context
// window: it resolves env > settings > server client-data > per-model default,
// and that default sits near 200K even for models whose real window is 1M. Left
// unset, long opus-5 sessions compacted at ~166K — roughly 5x more often than the
// model requires. buildPtyEnv pins the request to 1M; claude clamps it down to the
// model's own max, so smaller-window models (haiku-4-5) are unaffected.

/** buildPtyEnv is private and touches no instance state — reach it off the
 *  prototype so this stays a pure env test with no PTY/proxy setup. */
function buildPtyEnv(): Record<string, string> {
  const engine = Object.create(InteractiveClaudeEngine.prototype) as {
    buildPtyEnv(proxyPort?: number, sessionId?: string): Record<string, string>;
  };
  return engine.buildPtyEnv();
}

const ORIGINAL = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = ORIGINAL;
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
