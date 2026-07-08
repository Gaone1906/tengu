import { describe, expect, it } from "vitest";
import {
  CLAUDE_ALIAS_IDS,
  CLAUDE_EFFORT_LEVELS,
  claudeFallbackCandidates,
  knownClaudeModels,
  parseAnthropicModels,
  parseClaudeEffortLevels,
} from "../claude-models.js";

const ANTHROPIC_RESPONSE = {
  data: [
    {
      type: "model",
      id: "claude-sonnet-5",
      display_name: "Claude Sonnet 5",
      created_at: "2026-06-29T00:00:00Z",
      max_input_tokens: 1000000,
      capabilities: { effort: ["low", "medium", "high", "xhigh", "max"] },
    },
    {
      type: "model",
      id: "claude-opus-4-8",
      display_name: "Claude Opus 4.8",
      created_at: "2026-05-28T00:00:00Z",
      max_input_tokens: 1000000,
      capabilities: { effort: { values: ["low", "medium", "high", "xhigh", "max"] } },
    },
    {
      type: "model",
      id: "claude-sonnet-4-6",
      display_name: "Claude Sonnet 4.6",
      created_at: "2026-02-12T00:00:00Z",
      max_input_tokens: 200000,
      capabilities: { effort: { levels: ["low", "medium", "high", "max"] } },
    },
    {
      type: "model",
      id: "claude-fable-5",
      display_name: "Claude Fable 5",
      created_at: "2026-06-07T00:00:00Z",
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: { effort: ["low", "medium", "high", "xhigh", "max"] },
    },
  ],
};

describe("knownClaudeModels", () => {
  it("uses Claude Code aliases as the no-refresh fallback", () => {
    const known = knownClaudeModels();
    expect(known.defaultModel).toBe("opus");
    expect(known.models.map((m) => m.id)).toEqual([...CLAUDE_ALIAS_IDS]);
    expect(known.models.map((m) => m.label)).toEqual(["Opus (Latest)", "Sonnet (Latest)", "Fable (Latest)"]);
    expect(known.models[0].effortLevels).toEqual(CLAUDE_EFFORT_LEVELS);
  });
});

describe("parseAnthropicModels", () => {
  it("adds refreshed alias labels before concrete catalog models", () => {
    const parsed = parseAnthropicModels(ANTHROPIC_RESPONSE);
    expect(parsed.defaultModel).toBe("opus");
    expect(parsed.models.slice(0, 3).map((m) => [m.id, m.label])).toEqual([
      ["opus", "Opus 4.8"],
      ["sonnet", "Sonnet 5"],
      ["fable", "Fable 5"],
    ]);
    expect(parsed.models.map((m) => m.id)).toContain("claude-sonnet-5");
    expect(parsed.models.find((m) => m.id === "opus")?.contextWindow).toBe(1000000);
    expect(parsed.models.find((m) => m.id === "claude-sonnet-4-6")?.effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("uses the refreshed Claude Code effort list when the API omits effort capabilities", () => {
    const parsed = parseAnthropicModels({
      data: [{
        type: "model",
        id: "claude-sonnet-6",
        display_name: "Claude Sonnet 6",
        created_at: "2026-07-01T00:00:00Z",
      }],
    }, { effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] });
    expect(parsed.models.find((m) => m.id === "sonnet")?.effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });
});

describe("parseClaudeEffortLevels", () => {
  it("parses the read-only effort list from Claude Code help", () => {
    expect(parseClaudeEffortLevels(`
      --effort <level>                      Effort level for the current session
                                            (low, medium, high, xhigh, max)
      --model <model>                       Model for the current session.
    `)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("claudeFallbackCandidates", () => {
  it("falls back from a concrete latest model to previous same-family version then alias", () => {
    const parsed = parseAnthropicModels(ANTHROPIC_RESPONSE);
    expect(claudeFallbackCandidates(parsed.models, "claude-sonnet-5")).toEqual(["claude-sonnet-4-6", "sonnet"]);
  });

  it("does not fallback from already-alias-backed latest entries", () => {
    const parsed = parseAnthropicModels(ANTHROPIC_RESPONSE);
    expect(claudeFallbackCandidates(parsed.models, "sonnet")).toEqual([]);
  });
});
