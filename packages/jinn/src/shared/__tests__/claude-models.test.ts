import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_ALIAS_IDS,
  CLAUDE_EFFORT_LEVELS,
  claudeFallbackCandidates,
  claudeTokenFromCredentialsJson,
  knownClaudeModels,
  parseAnthropicModels,
  parseClaudeEffortLevels,
  readClaudeOAuthToken,
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

/**
 * Regression guard for the "Model (Latest)" bug: on macOS, Claude Code stores
 * its credentials in the login Keychain and writes no ~/.claude/.credentials.json.
 * A reader that only knew about the file returned no token, so discovery yielded
 * zero models and the registry silently degraded to the offline alias labels.
 */
describe("readClaudeOAuthToken", () => {
  const credentialsJson = (token: string, expiresAt?: number | string) =>
    JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt !== undefined ? { expiresAt } : {}) } });

  const HOUR = 3_600_000;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedEnv;
  });

  it("reads the macOS Keychain when no credentials file exists", async () => {
    const token = await readClaudeOAuthToken({
      platform: "darwin",
      home: "/nonexistent-home",
      readKeychain: async () => credentialsJson("sk-ant-oat01-keychain", Date.now() + HOUR),
    });
    expect(token).toBe("sk-ant-oat01-keychain");
  });

  it("ignores an expired Keychain token instead of returning it", async () => {
    const token = await readClaudeOAuthToken({
      platform: "darwin",
      home: "/nonexistent-home",
      readKeychain: async () => credentialsJson("sk-ant-oat01-stale", Date.now() - HOUR),
    });
    expect(token).toBeUndefined();
  });

  it("prefers CLAUDE_CODE_OAUTH_TOKEN over the Keychain", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-from-env";
    const token = await readClaudeOAuthToken({
      platform: "darwin",
      home: "/nonexistent-home",
      readKeychain: async () => credentialsJson("sk-ant-oat01-keychain", Date.now() + HOUR),
    });
    expect(token).toBe("sk-ant-oat01-from-env");
  });

  it("never shells out to the Keychain on non-darwin platforms", async () => {
    let called = false;
    const token = await readClaudeOAuthToken({
      platform: "linux",
      home: "/nonexistent-home",
      readKeychain: async () => {
        called = true;
        return credentialsJson("sk-ant-oat01-keychain", Date.now() + HOUR);
      },
    });
    expect(called).toBe(false);
    expect(token).toBeUndefined();
  });

  it("tolerates an unreadable Keychain (locked, or `security` missing)", async () => {
    const token = await readClaudeOAuthToken({
      platform: "darwin",
      home: "/nonexistent-home",
      readKeychain: async () => undefined,
    });
    expect(token).toBeUndefined();
  });
});

describe("claudeTokenFromCredentialsJson", () => {
  it("parses the shared credentials blob shape", () => {
    expect(
      claudeTokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "  sk-ant-tok  " } })),
    ).toBe("sk-ant-tok");
  });

  it("returns undefined for malformed or empty blobs", () => {
    expect(claudeTokenFromCredentialsJson("not json")).toBeUndefined();
    expect(claudeTokenFromCredentialsJson("{}")).toBeUndefined();
    expect(claudeTokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeUndefined();
  });
});
