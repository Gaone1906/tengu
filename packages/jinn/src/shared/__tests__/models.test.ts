import { describe, it, expect, beforeEach } from "vitest";
import type { JinnConfig } from "../types.js";
import { getModelRegistry, invalidateModelRegistry, setDiscoveredClaudeModelsForTest, synthesizeFromEngineConfig } from "../models.js";

function cfg(partial: Partial<JinnConfig["engines"]>, models?: JinnConfig["models"]): JinnConfig {
  return {
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
      ...partial,
    },
    models,
    connectors: {},
  } as JinnConfig;
}

beforeEach(() => {
  setDiscoveredClaudeModelsForTest(null);
  invalidateModelRegistry();
});

describe("synthesizeFromEngineConfig (backward-compat fallback)", () => {
  it("builds an entry per engine from engines.<name>.model", () => {
    const reg = synthesizeFromEngineConfig(cfg({}));
    expect(reg.claude.models[0].id).toBe("opus");
    expect(reg.claude.defaultModel).toBe("opus");
    expect(reg.codex.models[0].id).toBe("gpt-5.5");
    expect(reg.antigravity.models[0].id).toBe("Gemini 3.5 Flash (Medium)");
    expect(reg.grok.defaultModel).toBe("grok-build");
    expect(reg.grok.models.map((m) => m.id)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
    expect(reg.grok.models.map((m) => m.label)).toEqual(["Grok Build", "Grok Composer 2.5 Fast"]);
  });

  it("uses per-engine effort semantics: claude flag, codex config, grok flag, antigravity none", () => {
    const reg = synthesizeFromEngineConfig(cfg({}));
    expect(reg.claude.effortMechanism).toBe("claude-flag");
    expect(reg.claude.models[0].effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reg.codex.effortMechanism).toBe("codex-config");
    expect(reg.codex.models[0].effortLevels).toContain("xhigh");
    expect(reg.grok.effortMechanism).toBe("grok-flag");
    expect(reg.grok.models[0].effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reg.antigravity.effortMechanism).toBe("none");
    expect(reg.antigravity.models[0].supportsEffort).toBe(false);
    expect(reg.antigravity.models[0].effortLevels).toEqual([]);
  });

  it("uses the pinned Grok model as default while keeping the known Grok catalog", () => {
    const reg = synthesizeFromEngineConfig(cfg({ grok: { bin: "grok", model: "grok-composer-2.5-fast" } }));
    expect(reg.grok.defaultModel).toBe("grok-composer-2.5-fast");
    expect(reg.grok.models.map((m) => m.id)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
  });
});

describe("getModelRegistry with a models: block", () => {
  const models: JinnConfig["models"] = {
    claude: {
      default: "claude-opus-4-8",
      effortMechanism: "claude-flag",
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "claude-sonnet-4-6", label: "Sonnet 4.6", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
    codex: {
      default: "gpt-5.5",
      models: [{ id: "gpt-5.5", label: "GPT-5.5 Codex", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }],
    },
    antigravity: {
      models: [{ id: "gemini-3-flash-preview", label: "Gemini 3 Flash", supportsEffort: false, effortLevels: [] }],
    },
  };

  it("uses Claude alias fallback plus configured additions, while other engines honor configured models", () => {
    const reg = getModelRegistry(cfg({}, models));
    expect(reg.claude.models.slice(0, 3).map((m) => [m.id, m.label])).toEqual([
      ["opus", "Opus (Latest)"],
      ["sonnet", "Sonnet (Latest)"],
      ["fable", "Fable (Latest)"],
    ]);
    expect(reg.claude.models.find((m) => m.id === "claude-opus-4-8")?.label).toBe("Opus 4.8");
    expect(reg.codex.models[0].effortLevels).toContain("xhigh");
    expect(reg.antigravity.models[0].supportsEffort).toBe(false);
  });

  it("does not let stale configured Claude alias labels override the latest fallback label", () => {
    const reg = getModelRegistry(cfg({}, {
      claude: {
        default: "opus",
        models: [
          { id: "opus", label: "Opus 4.6", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
    }));

    expect(reg.claude.models.find((m) => m.id === "opus")?.label).toBe("Opus (Latest)");
    expect(reg.claude.models.find((m) => m.id === "opus")?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("resolves defaultModel from block.default, else the first model", () => {
    const reg = getModelRegistry(cfg({}, models));
    expect(reg.claude.defaultModel).toBe("opus");
    expect(reg.antigravity.defaultModel).toBe("gemini-3-flash-preview"); // no default → first
  });

  it("lets engines.grok.model pin the Grok default when models.grok is configured", () => {
    const reg = getModelRegistry(cfg(
      { grok: { bin: "grok", model: "grok-composer-2.5-fast" } },
      {
        grok: {
          default: "grok-build",
          effortMechanism: "grok-flag",
          models: [
            { id: "grok-build", label: "Grok Build", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 256000 },
            { id: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 256000 },
          ],
        },
      },
    ));

    expect(reg.grok.defaultModel).toBe("grok-composer-2.5-fast");
    expect(reg.grok.models[0].label).toBe("Grok Build");
    expect(reg.grok.models[0].contextWindow).toBe(256000);
  });

  it("merges discovered Claude aliases over a stale configured block while preserving custom entries", () => {
    setDiscoveredClaudeModelsForTest({
      defaultModel: "opus",
      models: [
        { id: "opus", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "sonnet", label: "Sonnet 5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "fable", label: "Fable 5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "claude-opus-4-8", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
      ],
    });

    const reg = getModelRegistry(cfg({}, {
      claude: {
        default: "opus",
        models: [
          { id: "opus", label: "Opus 4.7", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "claude-custom-preview", label: "Custom Preview", supportsEffort: false, effortLevels: [] },
        ],
      },
    }));

    expect(reg.claude.defaultModel).toBe("opus");
    expect(reg.claude.models.find((m) => m.id === "opus")?.label).toBe("Opus 4.8");
    expect(reg.claude.models.find((m) => m.id === "claude-custom-preview")?.label).toBe("Custom Preview");
  });

  it("hides configured model ids from a discovered catalog", () => {
    setDiscoveredClaudeModelsForTest({
      defaultModel: "opus",
      models: [
        { id: "opus", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "sonnet", label: "Sonnet 5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
      ],
    });

    const reg = getModelRegistry(cfg({}, {
      claude: {
        default: "opus",
        hidden: ["sonnet"],
        models: [],
      },
    }));

    expect(reg.claude.models.map((m) => m.id)).toEqual(["opus"]);
    expect(reg.claude.defaultModel).toBe("opus");
  });
});

describe("featured models (registry marking)", () => {
  it("marks the three latest alias families (opus/sonnet/fable) featured by default; concrete ids are not", () => {
    setDiscoveredClaudeModelsForTest({
      defaultModel: "opus",
      models: [
        { id: "opus", label: "Opus (Latest)", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "sonnet", label: "Sonnet (Latest)", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "fable", label: "Fable (Latest)", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "claude-opus-4-8", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "claude-haiku-4-5", label: "Haiku 4.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    });
    const reg = getModelRegistry(cfg({}));
    const featured = reg.claude.models.filter((m) => m.featured).map((m) => m.id);
    expect(featured).toEqual(["opus", "sonnet", "fable"]);
    expect(reg.claude.models.find((m) => m.id === "claude-opus-4-8")?.featured).toBeFalsy();
  });

  it("honors engines.claude.featuredModels as an override", () => {
    setDiscoveredClaudeModelsForTest({
      defaultModel: "opus",
      models: [
        { id: "opus", label: "Opus (Latest)", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "sonnet", label: "Sonnet (Latest)", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "fable", label: "Fable (Latest)", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "claude-haiku-4-5", label: "Haiku 4.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    });
    const reg = getModelRegistry(cfg({ claude: { bin: "claude", model: "opus", featuredModels: ["opus", "claude-haiku-4-5"] } }));
    const featured = reg.claude.models.filter((m) => m.featured).map((m) => m.id);
    expect(featured).toEqual(["opus", "claude-haiku-4-5"]);
  });

  it("treats an explicit empty featuredModels as no featured marking", () => {
    setDiscoveredClaudeModelsForTest({
      defaultModel: "opus",
      models: [
        { id: "opus", label: "Opus (Latest)", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "sonnet", label: "Sonnet (Latest)", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    });
    const reg = getModelRegistry(cfg({ claude: { bin: "claude", model: "opus", featuredModels: [] } }));
    expect(reg.claude.models.some((m) => m.featured)).toBe(false);
  });

  it("marks aliases featured on the synthesized fallback (no discovery, no models block)", () => {
    const reg = getModelRegistry(cfg({}));
    const featured = reg.claude.models.filter((m) => m.featured).map((m) => m.id);
    expect(featured).toEqual(["opus", "sonnet", "fable"]);
  });
});

describe("cache + invalidate", () => {
  it("caches across calls and refreshes only after invalidate", () => {
    const a = getModelRegistry(cfg({}));
    const b = getModelRegistry(cfg({ claude: { bin: "claude", model: "CHANGED" } }));
    expect(b).toBe(a); // cached — ignores the new config until invalidated
    invalidateModelRegistry();
    const c = getModelRegistry(cfg({ claude: { bin: "claude", model: "CHANGED" } }));
    expect(c.claude.models[0].id).toBe("CHANGED");
  });
});
