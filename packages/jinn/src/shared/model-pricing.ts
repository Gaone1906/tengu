export interface ModelPrice {
  input: number;
  cachedInput: number;
  cacheWrite?: number;
  output: number;
}

export interface ModelUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

// USD per million tokens, verified 2026-07-30 against the providers' pricing pages:
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/pricing
const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  "claude-opus-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-8": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-7": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-6": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-sonnet-4-5": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-haiku-4-5": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 15 },
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6 },
};

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  "gpt-5.6": "gpt-5.6-sol",
};

export function normalizeModelId(model: string): string {
  const unprefixed = model.trim().toLowerCase().replace(/^(?:anthropic|openai|openai-codex):/, "");
  const undated = unprefixed
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return MODEL_ALIASES[undated] ?? undated;
}

export function priceFor(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const normalized = normalizeModelId(model);
  if (normalized.startsWith("ollama/")) {
    return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  }
  return MODEL_PRICES[normalized];
}

export function costOfUsage(model: string | undefined, usage: ModelUsage): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  return (
    (usage.inputTokens ?? 0) * price.input
    + (usage.cachedInputTokens ?? 0) * price.cachedInput
    + (usage.cacheWriteInputTokens ?? 0) * (price.cacheWrite ?? price.input)
    + (usage.outputTokens ?? 0) * price.output
  ) / 1_000_000;
}
