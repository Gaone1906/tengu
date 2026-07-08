import { describe, expect, it } from "vitest";
import { isModelAvailabilityError, selectClaudeModelFallback } from "../model-fallback.js";

describe("isModelAvailabilityError", () => {
  it("detects model availability failures without catching auth/quota/network errors", () => {
    expect(isModelAvailabilityError("API Error 404: model: claude-sonnet-5 does not exist")).toBe(true);
    expect(isModelAvailabilityError("invalid model 'claude-sonnet-5'")).toBe(true);
    expect(isModelAvailabilityError("model is not available for this account")).toBe(true);

    expect(isModelAvailabilityError("rate_limit_error: requests are limited")).toBe(false);
    expect(isModelAvailabilityError("401 unauthorized: invalid API key")).toBe(false);
    expect(isModelAvailabilityError("network timeout contacting api.anthropic.com")).toBe(false);
    expect(isModelAvailabilityError("billing credits exhausted")).toBe(false);
  });
});

describe("selectClaudeModelFallback", () => {
  const models = [
    { id: "sonnet", label: "Sonnet 5", supportsEffort: true, effortLevels: ["medium"] },
    { id: "claude-sonnet-5", label: "Sonnet 5", supportsEffort: true, effortLevels: ["medium"] },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", supportsEffort: true, effortLevels: ["medium"] },
  ];

  it("selects the next same-family Claude model only for availability errors", () => {
    expect(selectClaudeModelFallback({
      engine: "claude",
      requestedModel: "claude-sonnet-5",
      error: "model claude-sonnet-5 does not exist",
      models,
    })).toBe("claude-sonnet-4-6");

    expect(selectClaudeModelFallback({
      engine: "claude",
      requestedModel: "claude-sonnet-5",
      error: "rate limit exceeded",
      models,
    })).toBeUndefined();
  });
});
