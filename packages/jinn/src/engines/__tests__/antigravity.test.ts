import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { AntigravityEngine } from "../antigravity.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

function makeEngine(): AntigravityEngine {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 2 });
  return new AntigravityEngine(lifecycle);
}

describe("AntigravityEngine (shape)", () => {
  it("implements the InterruptibleEngine + PtyViewEngine surface", () => {
    const e = makeEngine();
    expect(e.name).toBe("antigravity");
    for (const m of [
      "run", "kill", "isAlive", "killAll",
      "hasWarmPty", "ensureIdleSpawn", "restartPty", "subscribeWithSnapshot",
      "setViewing", "writeStdin", "resizePty", "isTurnRunning",
    ]) {
      expect(typeof (e as any)[m]).toBe("function");
    }
  });

  it("run() rejects without a sessionId", async () => {
    const e = makeEngine();
    await expect(e.run({ prompt: "hi", cwd: os.tmpdir() } as any)).rejects.toThrow(/sessionId/);
  });

  it("isAlive is false for an unknown session", () => {
    expect(makeEngine().isAlive("nope")).toBe(false);
  });

  it("isTurnRunning is false for an unknown session", () => {
    expect(makeEngine().isTurnRunning("nope")).toBe(false);
  });
});

/**
 * Real spawn→answer smoke test. Gated behind AGY_E2E=1 because it needs `agy`
 * installed and an authenticated Google session on the host (CI/other machines
 * have neither). Run locally with: AGY_E2E=1 pnpm --filter jinn-cli exec vitest run antigravity
 */
describe.skipIf(!process.env.AGY_E2E)("AntigravityEngine (e2e: real agy)", () => {
  it("spawns agy, sends a prompt, and reads the answer from the transcript", async () => {
    const e = makeEngine();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-"));
    const sessionId = `e2e-${Date.now()}`;
    const result = await e.run({
      prompt: "Reply with exactly the three words: alpha beta gamma",
      cwd,
      sessionId,
    });
    expect(result.error).toBeUndefined();
    expect(result.result.toLowerCase()).toContain("alpha beta gamma");
    expect(result.sessionId).toMatch(/[0-9a-f-]{8,}/); // a conversation UUID
    e.killAll();
  }, 90_000);
});

/**
 * Antigravity reads MCP server specs from Gemini config; the session id and
 * bound capability stay per-process in the agy child env. This seam pins both:
 * full env inheritance for agy's own auth plus explicit Jinn caller identity.
 */
describe("buildAntigravityPtyEnv", () => {
  it("inherits JINN_GATEWAY_TOKEN and JINN_GATEWAY_URL from the gateway process env", async () => {
    const { buildAntigravityPtyEnv } = await import("../antigravity.js");
    const prevToken = process.env.JINN_GATEWAY_TOKEN;
    const prevUrl = process.env.JINN_GATEWAY_URL;
    process.env.JINN_GATEWAY_TOKEN = "tok-tier3";
    process.env.JINN_GATEWAY_URL = "http://127.0.0.1:59999";
    try {
      const env = buildAntigravityPtyEnv();
      expect(env.JINN_GATEWAY_TOKEN).toBe("tok-tier3");
      expect(env.JINN_GATEWAY_URL).toBe("http://127.0.0.1:59999");
      expect(env.TERM).toBe("xterm-256color");
    } finally {
      if (prevToken === undefined) delete process.env.JINN_GATEWAY_TOKEN; else process.env.JINN_GATEWAY_TOKEN = prevToken;
      if (prevUrl === undefined) delete process.env.JINN_GATEWAY_URL; else process.env.JINN_GATEWAY_URL = prevUrl;
    }
  });
});
