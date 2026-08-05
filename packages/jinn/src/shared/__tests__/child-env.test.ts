import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildEngineChildEnv } from "../child-env.js";

describe("buildEngineChildEnv", () => {
  // The gateway resolves CLAUDE_CONFIG_DIR against its own cwd; the engine is spawned
  // in the session's working directory. A relative value handed through untouched
  // would name two different directories — seeded consent flags the engine cannot see,
  // transcripts the gateway never finds.
  it("resolves a relative CLAUDE_CONFIG_DIR so the child agrees with the gateway", () => {
    const env = buildEngineChildEnv({ CLAUDE_CONFIG_DIR: "claude-state" });
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.resolve("claude-state"));
  });

  it("leaves an absolute CLAUDE_CONFIG_DIR alone", () => {
    const absolute = path.resolve(path.join("/srv", "claude"));
    const env = buildEngineChildEnv({ CLAUDE_CONFIG_DIR: absolute });
    expect(env.CLAUDE_CONFIG_DIR).toBe(absolute);
  });

  it("does not invent the variable when it is unset", () => {
    const env = buildEngineChildEnv({ PATH: "/usr/bin" });
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });

  it("still scrubs the engine-private keys", () => {
    const env = buildEngineChildEnv(
      { JINN_HOME_IDENTITY: "x", JINN_TAKE_PORT: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", KEEP: "yes" },
      { scrubClaudeCode: true },
    );
    expect(env).toEqual({ KEEP: "yes" });
  });
});
