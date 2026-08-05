import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { normalizeClaudeEngineConfig, validateConfigShape } from "../config.js";
import type { JinnConfig } from "../types.js";
import { expectPosixMode } from "../test-support/posix-mode.js";

describe("deprecated Talk configuration compatibility", () => {
  it("keeps the retired orchestrator keys source-compatible for patch upgrades", () => {
    const legacyTalkConfig = {
      enabled: false,
      engine: "claude",
      orchestratorModel: "sonnet",
      kokoro: { voice: "af_heart" },
    } satisfies NonNullable<JinnConfig["talk"]>;

    expect(legacyTalkConfig).toMatchObject({
      enabled: false,
      engine: "claude",
      orchestratorModel: "sonnet",
    });
  });
});

describe("normalizeClaudeEngineConfig", () => {
  it("applies the maxLivePtys default", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus" });
    expect(out.maxLivePtys).toBe(8);
  });

  it("preserves a configured maxLivePtys", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus", maxLivePtys: 16 });
    expect(out.maxLivePtys).toBe(16);
  });
});

describe("validateConfigShape", () => {
  it("accepts a minimal valid config", () => {
    expect(validateConfigShape({ engines: { claude: { bin: "claude", model: "opus" } } })).toEqual([]);
  });

  it("accepts a full default-shaped config", () => {
    expect(validateConfigShape({
      jinn: { version: "1.0.0" },
      gateway: { port: 7777, host: "127.0.0.1" },
      engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-5.5" } },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    })).toEqual([]);
  });

  it("accepts a config without a gateway block (downstream defaults apply)", () => {
    expect(validateConfigShape({ engines: { claude: {} } })).toEqual([]);
  });

  it("rejects null / empty files", () => {
    expect(validateConfigShape(null)).toHaveLength(1);
    expect(validateConfigShape(undefined)).toHaveLength(1);
  });

  it("rejects a config that parsed to a scalar or array", () => {
    expect(validateConfigShape("oops")[0]).toContain("expected a YAML mapping");
    expect(validateConfigShape([1, 2])[0]).toContain("expected a YAML mapping");
  });

  it("rejects a non-numeric gateway.port", () => {
    const problems = validateConfigShape({ gateway: { port: "7777" }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("gateway.port"))).toBe(true);
  });

  it("accepts a boolean gateway.notesEnabled flag and rejects other values", () => {
    expect(validateConfigShape({ gateway: { notesEnabled: false }, engines: { claude: {} } })).toEqual([]);
    const problems = validateConfigShape({ gateway: { notesEnabled: "false" }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("gateway.notesEnabled"))).toBe(true);
  });

  it("rejects missing engines / engines.claude", () => {
    expect(validateConfigShape({})[0]).toContain("engines");
    const problems = validateConfigShape({ engines: { default: "codex" } });
    expect(problems.some((p) => p.includes("engines.claude"))).toBe(true);
  });
});

describe("saveConfigAtomic", () => {
  // CONFIG_PATH is resolved at module load from process.env.JINN_HOME, so we
  // point it at a temp dir and re-import the module (same pattern as the cron
  // jobs tests).
  let tmpHome: string;
  const prevHome = process.env.JINN_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-config-save-"));
    process.env.JINN_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = prevHome;
    vi.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes valid YAML to config.yaml and leaves no tmp file behind", async () => {
    const { saveConfigAtomic } = await import("../config.js");
    const configPath = path.join(tmpHome, "config.yaml");
    const cfg = { gateway: { port: 7777 }, talk: { engine: "claude", note: "x".repeat(200) } };

    saveConfigAtomic(cfg, { lineWidth: -1 });

    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual(cfg);
    // lineWidth: -1 → the long string must not be folded across lines
    expect(fs.readFileSync(configPath, "utf-8")).toContain("x".repeat(200));
    expect(fs.readdirSync(tmpHome).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("replaces an existing config.yaml", async () => {
    const { saveConfigAtomic } = await import("../config.js");
    const configPath = path.join(tmpHome, "config.yaml");
    fs.writeFileSync(configPath, "old: true\n");

    saveConfigAtomic({ fresh: 1 });

    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual({ fresh: 1 });
  });

  it("creates and replaces config.yaml with owner-only permissions", async () => {
    const { saveConfigAtomic } = await import("../config.js");
    const configPath = path.join(tmpHome, "config.yaml");

    saveConfigAtomic({ fresh: 1 });
    expectPosixMode(configPath, 0o600);

    fs.chmodSync(configPath, 0o600);
    saveConfigAtomic({ fresh: 2 });
    expectPosixMode(configPath, 0o600);
  });
});
