import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  searchKnowledge,
  readKnowledgeFile,
  KNOWLEDGE_SEARCH_LIMIT,
  KNOWLEDGE_FILE_CHAR_CAP,
  KNOWLEDGE_SNIPPET_CHAR_CAP,
} from "../store.js";

/**
 * GRS-020b — the knowledge store: the FIRST filesystem-reading primitive on
 * the MCP belt, so the containment battery here is the slice's security
 * acceptance. Two tiers:
 *   1. SEARCH — deterministic token-AND matching over the two allowlisted
 *      roots, hardened query, snippets only (never bodies), caps.
 *   2. READ CONTAINMENT — any regular file inside the instance is readable,
 *      while `..`, absolute paths, NUL bytes, and symlinks outside the instance
 *      remain rejected.
 */

let home: string;
let outsideFile: string;

/** Seed a file under the temp home, creating parent dirs. */
function seed(rel: string, content: string): string {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-store-"));
  seed(
    "knowledge/pricing-strategy.md",
    "# Pricing strategy 2026\n\nThe axolotl tier was approved at 19 euro after the June review.\nRepeat: axolotl axolotl.\n",
  );
  seed("knowledge/competitor-notes.md", "# Competitors\n\nNothing about amphibians here, only pricing tables.\n");
  seed("docs/architecture.md", "# Architecture\n\nThe gateway daemon spawns engines; the axolotl tier is billed there.\n");
  seed("docs/notes.txt", "axolotl axolotl axolotl — txt files are NOT searchable");
  seed("secrets/api-keys.json", JSON.stringify({ secret: "TOPSECRET-zq9" }));
  seed("config.yaml", "gateway:\n  port: 7777\n");
  seed("knowledge/competitor-scout-2026-07/steal-these-playbook.md", "# Nested playbook\n\nShip the useful pattern.\n");
  outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-outside-")), "outside.md");
  fs.writeFileSync(outsideFile, "TOPSECRET-outside");
  fs.symlinkSync(outsideFile, path.join(home, "knowledge", "escape.md"));
  // A benign symlink that stays inside the root.
  fs.symlinkSync(path.join(home, "knowledge", "pricing-strategy.md"), path.join(home, "knowledge", "alias.md"));
});

describe("searchKnowledge", () => {
  it("finds files across BOTH roots, with relative paths, titles, «»-marked snippets, and match counts", () => {
    const hits = searchKnowledge("axolotl", home);
    const paths = hits.map((h) => h.path);
    expect(paths).toContain("knowledge/pricing-strategy.md");
    expect(paths).toContain("docs/architecture.md");
    const pricing = hits.find((h) => h.path === "knowledge/pricing-strategy.md")!;
    expect(pricing.title).toBe("Pricing strategy 2026");
    expect(pricing.snippet).toContain("«axolotl»");
    expect(pricing.matchCount).toBeGreaterThanOrEqual(3);
    // Snippets are excerpts, never bodies.
    expect(pricing.snippet.length).toBeLessThanOrEqual(KNOWLEDGE_SNIPPET_CHAR_CAP);
    expect(pricing.snippet).not.toContain("June review.\nRepeat");
  });

  it("multi-word queries AND together (all words must appear), case-insensitively", () => {
    const hits = searchKnowledge("AXOLOTL approved", home);
    // alias.md is the benign in-root symlink to the same file — both match.
    expect(hits.map((h) => h.path)).toEqual(["knowledge/alias.md", "knowledge/pricing-strategy.md"]);
    expect(searchKnowledge("axolotl zzz-neverthere", home)).toEqual([]);
  });

  it("matches on the filename too", () => {
    const hits = searchKnowledge("competitor-notes", home);
    expect(hits.map((h) => h.path)).toContain("knowledge/competitor-notes.md");
  });

  it("ignores non-.md files entirely", () => {
    const hits = searchKnowledge("axolotl", home);
    expect(hits.map((h) => h.path)).not.toContain("docs/notes.txt");
  });

  it("never reads through a symlink that escapes the root (no content leak into search)", () => {
    expect(searchKnowledge("TOPSECRET-zq9", home)).toEqual([]);
  });

  it("follows a symlink that stays INSIDE the root", () => {
    const hits = searchKnowledge("axolotl", home);
    expect(hits.map((h) => h.path)).toContain("knowledge/alias.md");
  });

  it("hardens the query: control bytes are separators, hostile/oversized queries return normally", () => {
    const clean = searchKnowledge("axolotl", home);
    expect(searchKnowledge("axolotl\u0000", home).map((h) => h.path)).toEqual(clean.map((h) => h.path));
    expect(searchKnowledge("\u0000", home)).toEqual([]);
    expect(searchKnowledge("", home)).toEqual([]);
    expect(searchKnowledge("   ", home)).toEqual([]);
    // A 10 KB query is processed deterministically (no throw, no hit).
    expect(searchKnowledge(`zz${"y".repeat(10_000)}`, home)).toEqual([]);
  });

  it("caps results at the limit, deterministically ordered (matchCount desc, then path)", () => {
    for (let i = 0; i < KNOWLEDGE_SEARCH_LIMIT + 5; i++) {
      seed(`knowledge/bulk-${String(i).padStart(2, "0")}.md`, "# Bulk\n\ncommon-bulk-term here\n");
    }
    const hits = searchKnowledge("common-bulk-term", home);
    expect(hits).toHaveLength(KNOWLEDGE_SEARCH_LIMIT);
    const sorted = [...hits].sort((a, b) => b.matchCount - a.matchCount || a.path.localeCompare(b.path));
    expect(hits).toEqual(sorted);
  });

  it("returns [] when the roots do not exist", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-empty-"));
    expect(searchKnowledge("anything", empty)).toEqual([]);
  });
});

describe("readKnowledgeFile — happy path", () => {
  it("reads one file by the relative path search returned", () => {
    const r = readKnowledgeFile("knowledge/pricing-strategy.md", home);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe("knowledge/pricing-strategy.md");
    expect(r.title).toBe("Pricing strategy 2026");
    expect(r.content).toContain("approved at 19 euro");
    expect(r.truncated).toBe(false);
  });

  it("reads docs/ too", () => {
    const r = readKnowledgeFile("docs/architecture.md", home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("gateway daemon");
  });

  it("reads nested and non-Markdown files anywhere inside the instance", () => {
    const nested = readKnowledgeFile("knowledge/competitor-scout-2026-07/steal-these-playbook.md", home);
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.content).toContain("useful pattern");

    const config = readKnowledgeFile("config.yaml", home);
    expect(config.ok).toBe(true);
    if (config.ok) expect(config.content).toContain("port: 7777");
  });

  it("reads files in other instance directories", () => {
    const r = readKnowledgeFile("secrets/api-keys.json", home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("TOPSECRET-zq9");
  });

  it("caps content at KNOWLEDGE_FILE_CHAR_CAP with the intentional-cap marker", () => {
    seed("knowledge/huge.md", `# Huge\n\n${"x".repeat(KNOWLEDGE_FILE_CHAR_CAP + 5_000)}`);
    const r = readKnowledgeFile("knowledge/huge.md", home);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(KNOWLEDGE_FILE_CHAR_CAP + 200);
    expect(r.content).toMatch(/intentional cap/);
  });

  it("follows a symlink that resolves INSIDE the root", () => {
    const r = readKnowledgeFile("knowledge/alias.md", home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("axolotl");
  });
});

describe("readKnowledgeFile — the containment battery (every escape rejected)", () => {
  const rejected = (rel: string, reason?: string) => {
    const r = readKnowledgeFile(rel, home);
    expect(r.ok, `expected rejection for ${JSON.stringify(rel)}`).toBe(false);
    if (!r.ok && reason) expect(r.reason).toBe(reason);
  };

  it("rejects traversal shapes at the pattern gate", () => {
    rejected("../../etc/passwd", "invalid-path");
    rejected("../secrets/api-keys.json", "invalid-path");
    rejected("knowledge/../secrets/api-keys.json", "invalid-path");
    rejected("knowledge/../../secrets/api-keys.json", "invalid-path");
    rejected("docs/../knowledge/../../etc/passwd", "invalid-path");
    rejected("knowledge/..", "invalid-path");
  });

  it("rejects absolute paths", () => {
    rejected("/etc/passwd", "invalid-path");
    rejected(path.join(home, "secrets", "api-keys.json"), "invalid-path");
    rejected(path.join(home, "knowledge", "pricing-strategy.md"), "invalid-path"); // even inside — only relative paths
  });

  it("rejects backslashes and empty path segments", () => {
    rejected("knowledge\\..\\secrets\\api-keys.json", "invalid-path");
    rejected("knowledge/", "invalid-path");
  });

  it("rejects NUL and control bytes outright", () => {
    rejected("knowledge/pricing-strategy.md\u0000", "invalid-path");
    rejected("knowledge/pricing\u0000-strategy.md", "invalid-path");
    rejected("knowledge/foo.md", "invalid-path");
  });

  it("rejects empty and junk input", () => {
    rejected("", "invalid-path");
    rejected("   ", "invalid-path");
  });

  it("rejects a symlink inside the instance that resolves outside it", () => {
    const r = readKnowledgeFile("knowledge/escape.md", home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("forbidden");
    expect(JSON.stringify(r)).not.toContain("TOPSECRET-outside");
  });

  it("404s a missing file (valid shape, nothing there)", () => {
    rejected("knowledge/does-not-exist.md", "not-found");
  });

  it("404s a directory masquerading as a file", () => {
    fs.mkdirSync(path.join(home, "knowledge", "dir.md"), { recursive: true });
    rejected("knowledge/dir.md", "not-found");
  });
});
