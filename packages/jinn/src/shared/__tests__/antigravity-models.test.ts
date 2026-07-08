import { describe, expect, it } from "vitest";
import { parseAntigravityModels } from "../antigravity-models.js";

describe("parseAntigravityModels", () => {
  it("parses one model per non-empty `agy models` line without effort support", () => {
    const parsed = parseAntigravityModels(`
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Claude Sonnet 4.6 (Thinking)
`);

    expect(parsed.defaultModel).toBe("Gemini 3.5 Flash (Medium)");
    expect(parsed.models).toEqual([
      { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash Medium", supportsEffort: false, effortLevels: [] },
      { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash High", supportsEffort: false, effortLevels: [] },
      { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 Thinking", supportsEffort: false, effortLevels: [] },
    ]);
  });
});
