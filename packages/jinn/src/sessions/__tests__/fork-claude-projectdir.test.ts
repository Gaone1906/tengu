import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import path from "node:path";

/**
 * Regression test for claudeProjectDir() in ../fork.ts.
 *
 * Claude Code slugifies a cwd into its transcript directory by replacing every
 * "/" AND "." with "-". A buggy version replaced only "/", so a cwd like
 * `~/.jinn` mapped to `-Users-…-.jinn` instead of the real `-Users-…--jinn`
 * (double dash). The interactive fork then polled a non-existent directory and
 * timed out after 60s — breaking the Duplicate feature for every session whose
 * cwd contains a dot (i.e. every COO/.jinn session). This locks in the correct
 * slug, matching findTranscriptForSession() in claude-interactive.ts.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: { ...actual, homedir: () => "/home/test" },
    homedir: () => "/home/test",
  };
});

import { claudeProjectDir } from "../fork.js";

describe("claudeProjectDir", () => {
  // Resolved like claudeProjectDir() does, or the expectation misses the drive letter
  // path.resolve adds on Windows.
  const base = path.join(path.resolve(path.join("/home/test", ".claude")), "projects");

  // CLAUDE_CONFIG_DIR wins over the mocked homedir, so clear it to keep these
  // assertions about slugification rather than about the ambient environment.
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  beforeAll(() => { delete process.env.CLAUDE_CONFIG_DIR; });
  afterAll(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  });

  it("replaces both '/' and '.' with '-' for a dotted cwd (~/.jinn → --jinn)", () => {
    expect(claudeProjectDir("/Users/x/.jinn")).toBe(path.join(base, "-Users-x--jinn"));
  });

  it("handles a normal dotless cwd", () => {
    expect(claudeProjectDir("/Users/x/Projects/jinn")).toBe(
      path.join(base, "-Users-x-Projects-jinn"),
    );
  });

  it("handles multiple dotted segments", () => {
    expect(claudeProjectDir("/Users/x/.config/.app")).toBe(
      path.join(base, "-Users-x--config--app"),
    );
  });

  it("replaces every non-alphanumeric char (spaces, underscores, unicode)", () => {
    expect(claudeProjectDir("/Users/x/My Projects/app_v2 (béta)")).toBe(
      path.join(base, "-Users-x-My-Projects-app-v2--b-ta-"),
    );
  });
});
