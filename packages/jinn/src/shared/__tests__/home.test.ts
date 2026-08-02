import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolveClaudeConfigDir } from "../home.js";

describe("resolveClaudeConfigDir", () => {
  const original = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
  });

  it("defaults to ~/.claude", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(resolveClaudeConfigDir()).toBe(path.resolve(path.join(os.homedir(), ".claude")));
  });

  // path.resolve, not the literal: on Windows an absolute POSIX path gains the cwd's
  // drive letter, and the expectation has to travel the same road as production.
  it("follows CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = "/srv/jinn/claude";
    expect(resolveClaudeConfigDir()).toBe(path.resolve("/srv/jinn/claude"));
  });

  // Relative values must resolve, or the consumers disagree about the directory.
  it("resolves a relative CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = "claude-state";
    expect(resolveClaudeConfigDir()).toBe(path.resolve("claude-state"));
  });
});
