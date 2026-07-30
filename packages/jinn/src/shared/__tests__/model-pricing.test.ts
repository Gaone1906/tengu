import { describe, expect, it } from "vitest";
import { costOfUsage, priceFor } from "../model-pricing.js";

describe("model pricing", () => {
  it("leaves unknown models unpriced", () => {
    expect(priceFor("some-model-nobody-priced")).toBeUndefined();
  });

  it("normalizes dated Claude and provider-prefixed Codex model ids", () => {
    expect(priceFor("claude-opus-5-20260501")).toEqual(priceFor("claude-opus-5"));
    expect(priceFor("openai-codex:gpt-5.5")).toEqual(priceFor("gpt-5.5"));
  });

  it("prices fresh input, cache reads, cache writes, and output separately", () => {
    const mostlyCached = costOfUsage("claude-opus-5", {
      inputTokens: 50_000,
      cachedInputTokens: 900_000,
      cacheWriteInputTokens: 50_000,
      outputTokens: 10_000,
    });
    const allFresh = costOfUsage("claude-opus-5", {
      inputTokens: 1_000_000,
      outputTokens: 10_000,
    });

    expect(mostlyCached).toBe(1.2625);
    expect(allFresh).toBe(5.25);
    expect(mostlyCached).toBeLessThan(allFresh! / 4);
  });
});
