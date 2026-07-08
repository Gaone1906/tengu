import { describe, expect, it } from "vitest";
import { parseCodexModels } from "../codex-models.js";

describe("parseCodexModels", () => {
  it("parses visible Codex model metadata from `codex debug models` JSON", () => {
    const parsed = parseCodexModels(JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          visibility: "list",
          context_window: 258400,
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
          ],
        },
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          visibility: "hide",
          supported_reasoning_levels: [{ effort: "medium" }],
        },
      ],
    }));

    expect(parsed.defaultModel).toBe("gpt-5.5");
    expect(parsed.models).toEqual([
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        supportsEffort: true,
        effortLevels: ["low", "medium", "high", "xhigh"],
        contextWindow: 258400,
      },
    ]);
  });
});
