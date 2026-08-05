import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolveClaudeConfigDir, claudeJsonPath } from "../home.js";

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

describe("resolveClaudeConfigDir", () => {
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

describe("claudeJsonPath", () => {
  // Seeding a file the CLI does not read leaves the PTY blocked on the consent dialogs.
  // path.resolve on both sides: on Windows the production path gains the cwd's drive.
  it("follows CLAUDE_CONFIG_DIR when set", () => {
    const configDir = path.join("/somewhere", ".claude");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    expect(claudeJsonPath()).toBe(path.join(path.resolve(configDir), ".claude.json"));
  });

  it("falls back to the home directory when unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeJsonPath()).toBe(path.join(os.homedir(), ".claude.json"));
  });
});
