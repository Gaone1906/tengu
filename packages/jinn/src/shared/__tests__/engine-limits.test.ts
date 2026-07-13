/**
 * Engine-limits collector guards (server side of the Limits-page freshness fix).
 *
 * The collector is stateless: it reads the freshest CLI-written snapshot off
 * disk on every call. These tests prove the properties the honest UI depends
 * on — the fetched-at timestamp is the provider *capture* time (never
 * fabricated to "now"), staleness tracks the snapshot's real age, malformed or
 * unavailable providers degrade without leaking raw diagnostics, and a restart
 * (a fresh process re-reading the same disk) recovers identical data. Nothing
 * here drives a live provider: fake snapshot files + fs.utimes are the clock.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnConfig, EngineLimitsResponse } from "../types.js";

let JINN_HOME_TMP: string;
let CODEX_HOME_TMP: string;
let CLAUDE_DIR: string;
let collectEngineLimits: (c: JinnConfig, o?: { engine?: string }) => Promise<EngineLimitsResponse>;
let invalidateModelRegistry: () => void;

const NODE = process.execPath; // always an executable absolute path → engineAvailable=true

function cfg(engineOverrides: Record<string, unknown> = {}): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: NODE, model: "opus" },
      codex: { bin: NODE, model: "gpt-5.5" },
      ...engineOverrides,
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: ["low"] }] },
      codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5", supportsEffort: true, effortLevels: ["low"] }] },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

const MISSING_BIN = path.join(os.tmpdir(), "definitely-not-a-real-cli-xyz");

function writeClaudeSnapshot(name: string, body: string, ageMs: number): string {
  const file = path.join(CLAUDE_DIR, name);
  fs.writeFileSync(file, body);
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return file;
}

function writeCodexRollout(timestampIso: string, usedPercent: number): void {
  const day = path.join(CODEX_HOME_TMP, "sessions", "2026", "07", "13");
  fs.mkdirSync(day, { recursive: true });
  const line = JSON.stringify({
    timestamp: timestampIso,
    payload: { rate_limits: { primary: { used_percent: usedPercent, window_minutes: 300 } } },
  });
  fs.writeFileSync(path.join(day, "rollout-2026-07-13T00-00-00.jsonl"), `${line}\n`);
}

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-limits-"));
  JINN_HOME_TMP = path.join(root, "home");
  CODEX_HOME_TMP = path.join(root, "codex");
  CLAUDE_DIR = path.join(JINN_HOME_TMP, "tmp", "engine-limits", "claude");
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  process.env.JINN_HOME = JINN_HOME_TMP; // frozen into paths.ts at first import below
  process.env.CODEX_HOME = CODEX_HOME_TMP; // read per-call by the collector
  ({ collectEngineLimits } = await import("../engine-limits.js"));
  ({ invalidateModelRegistry } = await import("../models.js"));
});

afterAll(() => {
  delete process.env.JINN_HOME;
  delete process.env.CODEX_HOME;
});

beforeEach(() => {
  for (const f of fs.readdirSync(CLAUDE_DIR)) fs.rmSync(path.join(CLAUDE_DIR, f));
  invalidateModelRegistry();
});

describe("collectEngineLimits — claude statusline snapshot", () => {
  it("uses the snapshot capture time as fetched-at, not now", async () => {
    const capturedAt = new Date(Date.now() - 19 * 60 * 60_000).toISOString();
    writeClaudeSnapshot(
      "s.json",
      JSON.stringify({ captured_at: capturedAt, rate_limits: { five_hour: { used_percentage: 33, resets_at: 0 } } }),
      19 * 60 * 60_000,
    );
    const out = await collectEngineLimits(cfg(), { engine: "claude" });
    const claude = out.engines.claude;
    expect(claude.status).toBe("snapshot");
    expect(claude.refreshedAt).toBe(capturedAt);
    expect(claude.windows?.[0]?.usedPercent).toBe(33);
  });

  it("marks a >30min-old snapshot stale and a fresh one not stale", async () => {
    writeClaudeSnapshot(
      "old.json",
      JSON.stringify({ captured_at: new Date().toISOString(), rate_limits: { five_hour: { used_percentage: 10 } } }),
      45 * 60_000,
    );
    let out = await collectEngineLimits(cfg(), { engine: "claude" });
    expect(out.engines.claude.stale).toBe(true);

    fs.rmSync(path.join(CLAUDE_DIR, "old.json"));
    writeClaudeSnapshot(
      "new.json",
      JSON.stringify({ captured_at: new Date().toISOString(), rate_limits: { five_hour: { used_percentage: 10 } } }),
      60_000,
    );
    out = await collectEngineLimits(cfg(), { engine: "claude" });
    expect(out.engines.claude.stale).toBeFalsy();
  });

  it("degrades a malformed snapshot to fixed copy, leaking neither payload nor parser detail", async () => {
    // Content BEGINS with a sensitive marker and is invalid JSON — the projection
    // must expose neither the marker nor any parser diagnostic (position, token…).
    const marker = "SENSITIVE-SNAPSHOT-MARKER-a1b2c3";
    writeClaudeSnapshot("bad.json", `${marker} {"rate_limits": broken}`, 60_000);
    const out = await collectEngineLimits(cfg(), { engine: "claude" });
    const claude = out.engines.claude;
    expect(claude.status).toBe("error");
    expect(claude.error).toBeTruthy(); // fixed operator-safe copy is present…

    const projected = JSON.stringify(claude);
    expect(projected).not.toContain(marker); // …but no payload fragment…
    for (const diag of ["position", "Unexpected", "Expected", "in JSON", "SyntaxError"]) {
      expect(projected).not.toContain(diag); // …and no raw parser diagnostic.
    }
  });
});

describe("collectEngineLimits — codex session rollout", () => {
  it("reads the rollout snapshot off disk with its capture timestamp", async () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    writeCodexRollout(ts, 72);
    const out = await collectEngineLimits(cfg(), { engine: "codex" });
    const codex = out.engines.codex;
    expect(codex.status).toBe("snapshot");
    expect(codex.refreshedAt).toBe(ts);
    expect(codex.windows?.[0]?.usedPercent).toBe(72);
  });
});

describe("collectEngineLimits — recovery + unsupported", () => {
  it("recovers identical data across a simulated restart (stateless re-read)", async () => {
    const capturedAt = new Date().toISOString();
    writeClaudeSnapshot(
      "s.json",
      JSON.stringify({ captured_at: capturedAt, rate_limits: { five_hour: { used_percentage: 55 } } }),
      60_000,
    );
    const a = await collectEngineLimits(cfg(), { engine: "claude" });
    invalidateModelRegistry(); // fresh process would rebuild the registry
    const b = await collectEngineLimits(cfg(), { engine: "claude" });
    expect(b.engines.claude.refreshedAt).toBe(a.engines.claude.refreshedAt);
    expect(b.engines.claude.windows?.[0]?.usedPercent).toBe(55);
  });

  it("reports an installed engine with no local quota endpoint as unsupported", async () => {
    const out = await collectEngineLimits(cfg({ grok: { bin: NODE } }), { engine: "grok" });
    expect(out.engines.grok.status).toBe("unsupported");
    expect(out.engines.grok.unsupportedReason).toBeTruthy();
  });

  it("distinguishes a not-installed CLI (unavailable) from an unsupported one", async () => {
    // Grok CLI missing → temporarily unavailable, not durably unsupported.
    const grok = await collectEngineLimits(cfg({ grok: { bin: MISSING_BIN } }), { engine: "grok" });
    expect(grok.engines.grok.status).toBe("unavailable");
    expect(grok.engines.grok.unsupportedReason).toBeTruthy();

    // A first-class engine whose CLI is missing is unavailable, not unsupported.
    invalidateModelRegistry(); // each config change rebuilds the registry (as a fresh process would)
    const claude = await collectEngineLimits(cfg({ claude: { bin: MISSING_BIN } }), { engine: "claude" });
    expect(claude.engines.claude.status).toBe("unavailable");
  });
});
