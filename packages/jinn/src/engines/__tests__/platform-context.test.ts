import { describe, expect, it } from "vitest";
import * as platformContext from "../platform-context.js";
import { buildPlatformContextSnapshot } from "../../sessions/context.js";
import type { JinnConfig } from "../../shared/types.js";

const { buildPromptWithPlatformContext, PLATFORM_CONTEXT_REFRESH_HEADING } = platformContext;

function snapshot(overrides: Record<string, unknown> = {}) {
  const config = {
    gateway: { host: "127.0.0.1", port: 7799 },
    engines: {
      default: "claude",
      claude: { model: "opus", effortLevel: "high" },
      codex: { model: "gpt-5.5" },
    },
    logging: { level: "info" },
  } as unknown as JinnConfig;
  return buildPlatformContextSnapshot({
    source: "web",
    channel: "web:session",
    thread: "thread-1",
    user: "operator",
    sessionId: "jinn-session",
    gatewayBootId: "boot-a",
    engine: "codex",
    model: "gpt-5.5",
    effortLevel: "medium",
    config,
    ...overrides,
  });
}

describe("platform context prompt decoration", () => {
  it("uses the full system context for a fresh engine transcript", () => {
    const prompt = buildPromptWithPlatformContext({
      prompt: "hello",
      systemPrompt: "# Full system context",
    });

    expect(prompt).toBe("# Full system context\n\nhello");
  });

  it("leaves an unchanged resumed turn raw", () => {
    const prompt = buildPromptWithPlatformContext({
      prompt: "second turn",
      resumeSessionId: "native-session",
      systemPrompt: [
        "# Full system context",
        "## Current session",
        "- Session ID: jinn-session",
        "## Current configuration",
        "- Gateway: http://127.0.0.1:7777",
      ].join("\n"),
    });

    expect(prompt).toBe("second turn");
  });

  it("prepends exactly one explicitly supplied refresh payload", () => {
    const refresh = [
      PLATFORM_CONTEXT_REFRESH_HEADING,
      "explicit canonical refresh",
    ].join("\n");
    const prompt = buildPromptWithPlatformContext({
      prompt: "changed turn",
      resumeSessionId: "native-session",
      systemPrompt: "# Full system context without parsed metadata headings",
      platformContextRefresh: refresh,
    } as Parameters<typeof buildPromptWithPlatformContext>[0] & { platformContextRefresh: string });

    expect(prompt).toBe(`${refresh}\n\nchanged turn`);
    expect(prompt.match(new RegExp(PLATFORM_CONTEXT_REFRESH_HEADING, "g"))).toHaveLength(1);
  });
});

describe("canonical platform context metadata", () => {
  it("builds the visible refresh from the same structured snapshot", () => {
    const buildRefresh = (platformContext as any).buildPlatformContextRefresh;
    expect(typeof buildRefresh).toBe("function");

    const refresh = buildRefresh(snapshot());
    expect(refresh).toContain(PLATFORM_CONTEXT_REFRESH_HEADING);
    expect(refresh).toContain("- Session ID: jinn-session");
    expect(refresh).toContain("- Gateway: http://127.0.0.1:7799");
    expect(refresh).toContain("- Active engine: codex");
    expect(refresh).toContain("- Active model: gpt-5.5");
    expect(refresh).toContain("- Active effort: medium");
    expect(refresh).not.toContain("boot-a");
  });

  it("SHA-256 fingerprints sorted structured values and changes on relevant metadata", () => {
    const fingerprint = (platformContext as any).fingerprintPlatformContext;
    expect(typeof fingerprint).toBe("function");

    const base = snapshot();
    const reordered = {
      ...base,
      configuredModels: {
        codex: base.configuredModels.codex,
        claude: base.configuredModels.claude,
      },
    };
    const baseHash = fingerprint(base);
    expect(baseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint(reordered)).toBe(baseHash);

    for (const changed of [
      { ...base, gatewayBootId: "boot-b" },
      { ...base, channel: "web:other" },
      { ...base, selectedEngine: "claude" },
      { ...base, resolvedModel: "opus" },
      { ...base, resolvedEffort: "high" },
      { ...base, gatewayBaseUrl: "http://127.0.0.1:7800" },
    ]) {
      expect(fingerprint(changed)).not.toBe(baseHash);
    }
  });
});
