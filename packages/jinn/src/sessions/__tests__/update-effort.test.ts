import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

// Isolate the DB: JINN_HOME must be set before importing registry (SESSIONS_DB
// is resolved at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-effort-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");

describe("updateSession persists model + effort_level (mid-chat switch backing store)", () => {
  it("round-trips a model + effortLevel change", async () => {
    (await import("../../shared/db.js")).initDb();
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "test-ref",
      model: "opus",
      effortLevel: "medium",
    });
    expect(s.model).toBe("opus");
    expect(s.effortLevel).toBe("medium");

    const updated = reg.updateSession(s.id, { model: "claude-sonnet-4-6", effortLevel: "high" });
    expect(updated?.model).toBe("claude-sonnet-4-6");
    expect(updated?.effortLevel).toBe("high");

    // Persisted (what the next turn reads).
    const reloaded = reg.getSession(s.id);
    expect(reloaded?.model).toBe("claude-sonnet-4-6");
    expect(reloaded?.effortLevel).toBe("high");
  });
});
