import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "../../shared/paths.js";
import { writeMcpConfigFile, cleanupMcpConfigFile, sweepOrphanMcpConfigFiles } from "../resolver.js";

/**
 * Issue #86 — the per-session --mcp-config file now lives as long as the PTY that
 * references it, not the turn. A hard kill can therefore orphan it, so boot sweeps
 * every dir whose session the registry no longer lists.
 */
const IDS = ["sweep-live", "sweep-orphan"];

afterEach(() => {
  for (const id of IDS) cleanupMcpConfigFile(id);
});

describe("sweepOrphanMcpConfigFiles", () => {
  it("removes configs for unknown sessions and keeps live ones", () => {
    const live = writeMcpConfigFile({ mcpServers: {} }, "sweep-live");
    const orphan = writeMcpConfigFile({ mcpServers: {} }, "sweep-orphan");

    const removed = sweepOrphanMcpConfigFiles(["sweep-live"]);

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("is a no-op when the temp root does not exist", () => {
    const root = path.join(JINN_HOME, "tmp", "mcp");
    if (!fs.existsSync(root)) {
      expect(sweepOrphanMcpConfigFiles([])).toBe(0);
    }
  });
});
