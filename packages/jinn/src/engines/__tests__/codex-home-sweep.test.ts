import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepOrphanCodexSessionHomes } from "../codex.js";

/**
 * Regression for the codex-home disk leak: per-session CODEX_HOME overlays are
 * removed on session teardown, but overlays whose session record is gone
 * accumulated forever (276 dirs / 2.4GB observed). The startup sweep must delete
 * exactly the orphans — overlays not backed by a known session — while keeping
 * live-session overlays and the shared caches.
 */
describe("sweepOrphanCodexSessionHomes", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-homes-sweep-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const mkdir = (name: string) => fs.mkdirSync(path.join(base, name), { recursive: true });
  const exists = (name: string) => fs.existsSync(path.join(base, name));

  it("removes overlays with no matching session and keeps the rest", () => {
    const live = "11111111-1111-1111-1111-111111111111";
    const orphanA = "22222222-2222-2222-2222-222222222222";
    const orphanB = "33333333-3333-3333-3333-333333333333";
    mkdir(live);
    mkdir(orphanA);
    mkdir(orphanB);
    // shared caches and dot-dirs must never be swept
    mkdir("cache");
    mkdir("skills");
    mkdir(".shared");

    const removed = sweepOrphanCodexSessionHomes([live], base);

    expect(removed).toBe(2);
    expect(exists(live)).toBe(true);
    expect(exists(orphanA)).toBe(false);
    expect(exists(orphanB)).toBe(false);
    expect(exists("cache")).toBe(true);
    expect(exists("skills")).toBe(true);
    expect(exists(".shared")).toBe(true);
  });

  it("is a no-op when the base dir does not exist", () => {
    const missing = path.join(base, "does-not-exist");
    expect(sweepOrphanCodexSessionHomes(["x"], missing)).toBe(0);
  });

  it("keeps every overlay when all are backed by known sessions", () => {
    const ids = ["aaaaaaaa-1111", "bbbbbbbb-2222"];
    ids.forEach(mkdir);
    expect(sweepOrphanCodexSessionHomes(ids, base)).toBe(0);
    ids.forEach((id) => expect(exists(id)).toBe(true));
  });
});
