import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reapStaleMcpTempSandboxes } from "../temp-sandbox.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("reapStaleMcpTempSandboxes", () => {
  it("removes only old sandboxes whose owner PID is dead", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reaper-test-"));
    roots.push(parent);
    const nowMs = Date.UTC(2026, 6, 12, 12, 0, 0);
    const old = new Date(nowMs - 10 * 60_000);
    const recent = new Date(nowMs - 10_000);

    const deadOld = path.join(parent, "jinn-mcp-111111-Ab12Cd");
    const liveOld = path.join(parent, "jinn-mcp-222222-Ef34Gh");
    const deadRecent = path.join(parent, "jinn-mcp-333333-Ij56Kl");
    const unrelated = path.join(parent, "jinn-mcp-not-owned");
    for (const dir of [deadOld, liveOld, deadRecent, unrelated]) fs.mkdirSync(dir);
    fs.utimesSync(deadOld, old, old);
    fs.utimesSync(liveOld, old, old);
    fs.utimesSync(deadRecent, recent, recent);
    fs.utimesSync(unrelated, old, old);

    const removed = reapStaleMcpTempSandboxes(parent, {
      nowMs,
      staleAfterMs: 60_000,
      isProcessAlive: (pid) => pid === 222222,
    });

    expect(removed).toBe(1);
    expect(fs.existsSync(deadOld)).toBe(false);
    expect(fs.existsSync(liveOld)).toBe(true);
    expect(fs.existsSync(deadRecent)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("never follows a matching symlink", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reaper-test-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reaper-target-"));
    roots.push(parent, target);
    const link = path.join(parent, "jinn-mcp-444444-Mn78Op");
    fs.symlinkSync(target, link);

    expect(reapStaleMcpTempSandboxes(parent, {
      nowMs: Date.now() + 120_000,
      staleAfterMs: 0,
      isProcessAlive: () => false,
    })).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
