import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KNOWLEDGE_FILE_CHAR_CAP,
  KNOWLEDGE_SEARCH_LIMIT,
  KNOWLEDGE_SNIPPET_CHAR_CAP,
  NOTE_FILE_MAX_BYTES,
  createNote,
  listNotes,
  readKnowledgeFile,
  readNote,
  searchKnowledge,
  updateNote,
} from "../store.js";

let home: string;

function seed(relativePath: string, content: string): string {
  const absolutePath = path.join(home, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  return absolutePath;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-notes-store-"));
  fs.mkdirSync(path.join(home, "knowledge"), { recursive: true });
});

describe("listNotes", () => {
  it("projects nested Markdown using its first heading as the title", () => {
    seed("knowledge/product/brief.md", "---\ntype: brief\n---\n# Launch brief\n\nShip calmly.\n");

    const { notes, folders } = listNotes({ home });

    expect(notes.find((note) => note.path === "knowledge/product/brief.md")).toMatchObject({
      title: "Launch brief",
      folder: "product",
      preview: "Ship calmly.",
    });
    expect(folders).toContainEqual({ path: "product", name: "product", count: 1 });
  });

  it("counts notes in every nested folder ancestor", () => {
    seed("knowledge/product/brief.md", "# Brief\n");
    seed("knowledge/product/research/results.md", "# Results\n");

    expect(listNotes({ home }).folders).toEqual([
      { path: "product", name: "product", count: 2 },
      { path: "product/research", name: "research", count: 1 },
    ]);
  });

  it("falls back to the filename stem when no heading exists", () => {
    seed("knowledge/scratch-pad.md", "Loose thought.\n");

    const note = listNotes({ home }).notes[0];
    expect(note).toMatchObject({
      title: "scratch-pad",
      preview: "Loose thought.",
    });
    expect(note).not.toHaveProperty("body");
  });

  it("orders notes newest first with a stable path tie-break", () => {
    const older = seed("knowledge/a.md", "# A\n");
    const newer = seed("knowledge/z.md", "# Z\n");
    fs.utimesSync(older, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    fs.utimesSync(newer, new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"));

    expect(listNotes({ home }).notes.map((note) => note.path)).toEqual([
      "knowledge/z.md",
      "knowledge/a.md",
    ]);
  });

  it("filters by title, path, or body text", () => {
    seed("knowledge/product/brief.md", "# Launch brief\n\nShip calmly.\n");
    seed("knowledge/other.md", "# Other\n\nWait.\n");

    expect(listNotes({ home, query: "calmly" }).notes.map((note) => note.path)).toEqual([
      "knowledge/product/brief.md",
    ]);
  });

  it("omits hidden entries, non-Markdown files, and every symlink", () => {
    seed("knowledge/visible.md", "# Visible\n");
    seed("knowledge/.hidden.md", "# Hidden\n");
    seed("knowledge/.private/note.md", "# Private\n");
    seed("knowledge/notes.txt", "# Text\n");
    const outside = seed("outside/secret.md", "# Secret\n");
    fs.symlinkSync(outside, path.join(home, "knowledge", "escaped.md"));
    fs.symlinkSync(path.join(home, "knowledge", "visible.md"), path.join(home, "knowledge", "alias.md"));
    fs.symlinkSync(path.join(home, "outside"), path.join(home, "knowledge", "linked-folder"));

    expect(listNotes({ home }).notes.map((note) => note.path)).toEqual(["knowledge/visible.md"]);
  });
});

describe("readNote", () => {
  it("returns the editable body and a revision of the exact file bytes", () => {
    const content = "---\ntype: brief\n---\n\n## Launch brief\n\nShip calmly.\n";
    seed("knowledge/product/brief.md", content);

    const result = readNote("knowledge/product/brief.md", home);

    expect(result).toMatchObject({
      ok: true,
      value: {
        title: "Launch brief",
        body: "Ship calmly.",
        folder: "product",
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("rejects absolute, traversal, control-byte, backslash, hidden, and docs paths", () => {
    for (const notePath of [
      "/tmp/note.md",
      "knowledge/../secrets/note.md",
      "knowledge/a/../../note.md",
      `knowledge/a${String.fromCharCode(0)}b.md`,
      "knowledge\\note.md",
      "knowledge/.private/note.md",
      "docs/note.md",
    ]) {
      expect(readNote(notePath, home), JSON.stringify(notePath)).toMatchObject({
        ok: false,
        reason: "invalid-path",
      });
    }
  });

  it("refuses symlink leaves without reading their targets", () => {
    const outside = seed("outside/secret.md", "# Secret\n\nDo not expose.\n");
    fs.symlinkSync(outside, path.join(home, "knowledge", "escaped.md"));

    const result = readNote("knowledge/escaped.md", home);

    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    expect(JSON.stringify(result)).not.toContain("Do not expose");
  });
});

describe("createNote", () => {
  it("creates unique slugs without overwriting an existing note", () => {
    const first = createNote({ title: "Release Plan", body: "One" }, home);
    const second = createNote({ title: "Release Plan", body: "Two" }, home);

    expect(first).toMatchObject({ ok: true, value: { path: "knowledge/release-plan.md", body: "One" } });
    expect(second).toMatchObject({ ok: true, value: { path: "knowledge/release-plan-2.md", body: "Two" } });
  });

  it("creates safe nested folders", () => {
    const result = createNote({ title: "Outline", folder: "product/research" }, home);

    expect(result).toMatchObject({
      ok: true,
      value: { path: "knowledge/product/research/outline.md", folder: "product/research" },
    });
  });

  it("rejects unsafe folder paths", () => {
    for (const folder of ["/tmp", "../outside", "product/../../outside", "product\\research", ".private", `bad${String.fromCharCode(1)}`]) {
      expect(createNote({ title: "Plan", folder }, home), JSON.stringify(folder)).toMatchObject({
        ok: false,
        reason: "invalid-path",
      });
    }
  });

  it("refuses a symlink leaf instead of selecting a different slug", () => {
    const outside = seed("outside/plan.md", "# Outside\n");
    fs.symlinkSync(outside, path.join(home, "knowledge", "plan.md"));

    expect(createNote({ title: "Plan" }, home)).toMatchObject({ ok: false, reason: "forbidden" });
  });

  it("refuses to create through a symlinked parent", () => {
    fs.mkdirSync(path.join(home, "outside-folder"));
    fs.symlinkSync(path.join(home, "outside-folder"), path.join(home, "knowledge", "linked"));

    expect(createNote({ title: "Plan", folder: "linked" }, home)).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
  });
});

describe("updateNote", () => {
  it("preserves frontmatter and the existing heading level while replacing title and body", () => {
    seed("knowledge/plan.md", "---\ntype: plan\nowner: team\n---\n\n### Old title\n\nOld body.\n");
    const before = readNote("knowledge/plan.md", home);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const result = updateNote({
      path: "knowledge/plan.md",
      expectedRevision: before.value.revision,
      title: "New title",
      body: "New body.",
    }, home);

    expect(result).toMatchObject({ ok: true, value: { title: "New title", body: "New body." } });
    expect(fs.readFileSync(path.join(home, "knowledge", "plan.md"), "utf-8")).toBe(
      "---\ntype: plan\nowner: team\n---\n\n### New title\n\nNew body.\n",
    );
  });

  it("changes only the heading title bytes when no body edit is requested", () => {
    const original = "Preamble stays exact.\r\n## Old title   \r\n\r\nBody spacing.  \r\n";
    seed("knowledge/exact.md", original);
    const before = readNote("knowledge/exact.md", home);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const result = updateNote({
      path: "knowledge/exact.md",
      expectedRevision: before.value.revision,
      title: "New title",
    }, home);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(home, "knowledge", "exact.md"), "utf-8")).toBe(
      original.replace("Old title", "New title"),
    );
  });

  it("appends with one blank line", () => {
    const created = createNote({ title: "Ideas", body: "One" }, home);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = updateNote({
      path: created.value.path,
      expectedRevision: created.value.revision,
      append: "Two",
    }, home);

    expect(updated).toMatchObject({ ok: true, value: { body: "One\n\nTwo" } });
  });

  it("refuses a stale revision without changing bytes", () => {
    const created = createNote({ title: "Plan", body: "One" }, home);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = updateNote({ path: created.value.path, expectedRevision: created.value.revision, body: "Two" }, home);
    expect(first.ok).toBe(true);
    const bytesAfterFirst = fs.readFileSync(path.join(home, created.value.path));

    const stale = updateNote({ path: created.value.path, expectedRevision: created.value.revision, append: "Three" }, home);

    expect(stale).toMatchObject({
      ok: false,
      reason: "conflict",
      currentRevision: first.ok ? first.value.revision : undefined,
    });
    expect(fs.readFileSync(path.join(home, created.value.path))).toEqual(bytesAfterFirst);
    expect(readNote(created.value.path, home)).toMatchObject({ ok: true, value: { body: "Two" } });
  });

  it("atomically replaces the destination file", () => {
    const created = createNote({ title: "Plan", body: "One" }, home);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const absolutePath = path.join(home, created.value.path);
    const inodeBefore = fs.statSync(absolutePath).ino;

    const updated = updateNote({
      path: created.value.path,
      expectedRevision: created.value.revision,
      body: "Two",
    }, home);

    expect(updated.ok).toBe(true);
    expect(fs.statSync(absolutePath).ino).not.toBe(inodeBefore);
    expect(fs.readdirSync(path.dirname(absolutePath)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("rejects mutually exclusive body and append edits", () => {
    const created = createNote({ title: "Plan", body: "One" }, home);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(updateNote({
      path: created.value.path,
      expectedRevision: created.value.revision,
      body: "Two",
      append: "Three",
    }, home)).toMatchObject({ ok: false, reason: "invalid-path" });
  });
});

describe("file-size cap", () => {
  it("omits oversized files from lists and refuses direct reads", () => {
    seed("knowledge/huge.md", `# Huge\n\n${"x".repeat(NOTE_FILE_MAX_BYTES)}`);

    expect(listNotes({ home }).notes).toEqual([]);
    expect(readNote("knowledge/huge.md", home)).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("refuses creates and updates that exceed the cap", () => {
    expect(createNote({ title: "Huge", body: "x".repeat(NOTE_FILE_MAX_BYTES) }, home)).toMatchObject({
      ok: false,
      reason: "too-large",
    });
    const created = createNote({ title: "Small", body: "One" }, home);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(updateNote({
      path: created.value.path,
      expectedRevision: created.value.revision,
      body: "x".repeat(NOTE_FILE_MAX_BYTES),
    }, home)).toMatchObject({ ok: false, reason: "too-large" });
  });
});

/**
 * GRS-020b search + instance read, re-homed here (PLA-52) so a single module owns
 * knowledge/. Search now runs the same recursive, symlink-refusing regime as the
 * Notes surface above; readKnowledgeFile is unchanged, and its containment battery
 * is the security acceptance for the whole read primitive. These suites share one
 * instance fixture, independent of the per-test Notes `home` above.
 */

let instanceHome: string;
let outsideFile: string;

function seedInstance(rel: string, content: string): string {
  const abs = path.join(instanceHome, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeAll(() => {
  instanceHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-store-"));
  seedInstance(
    "knowledge/pricing-strategy.md",
    "# Pricing strategy 2026\n\nThe axolotl tier was approved at 19 euro after the June review.\nRepeat: axolotl axolotl.\n",
  );
  seedInstance("knowledge/competitor-notes.md", "# Competitors\n\nNothing about amphibians here, only pricing tables.\n");
  seedInstance("docs/architecture.md", "# Architecture\n\nThe gateway daemon spawns engines; the axolotl tier is billed there.\n");
  seedInstance("docs/notes.txt", "axolotl axolotl axolotl — txt files are NOT searchable");
  seedInstance("secrets/api-keys.json", JSON.stringify({ secret: "TOPSECRET-zq9" }));
  seedInstance("config.yaml", "gateway:\n  port: 7777\n");
  seedInstance("knowledge/competitor-scout-2026-07/steal-these-playbook.md", "# Nested playbook\n\nShip the useful newt pattern.\n");
  seedInstance("docs/adr/0001-engine-registry.md", "# Engine registry\n\nA nested newt decision record.\n");
  outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-outside-")), "outside.md");
  fs.writeFileSync(outsideFile, "TOPSECRET-outside");
  fs.symlinkSync(outsideFile, path.join(instanceHome, "knowledge", "escape.md"));
  // A benign symlink that stays inside the root.
  fs.symlinkSync(path.join(instanceHome, "knowledge", "pricing-strategy.md"), path.join(instanceHome, "knowledge", "alias.md"));
});

describe("searchKnowledge", () => {
  it("finds files across BOTH roots, with relative paths, titles, «»-marked snippets, and match counts", () => {
    const hits = searchKnowledge("axolotl", instanceHome);
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
    const hits = searchKnowledge("AXOLOTL approved", instanceHome);
    expect(hits.map((h) => h.path)).toEqual(["knowledge/pricing-strategy.md"]);
    expect(searchKnowledge("axolotl zzz-neverthere", instanceHome)).toEqual([]);
  });

  it("matches on the filename too", () => {
    const hits = searchKnowledge("competitor-notes", instanceHome);
    expect(hits.map((h) => h.path)).toContain("knowledge/competitor-notes.md");
  });

  it("ignores non-.md files entirely", () => {
    const hits = searchKnowledge("axolotl", instanceHome);
    expect(hits.map((h) => h.path)).not.toContain("docs/notes.txt");
  });

  it("never reads through a symlink that escapes the root (no content leak into search)", () => {
    expect(searchKnowledge("TOPSECRET-zq9", instanceHome)).toEqual([]);
  });

  it("skips a symlink that stays INSIDE the root", () => {
    // PLA-52 D3: search now runs the stricter Notes regime — every symlink is
    // refused, so an in-root alias no longer surfaces as a second hit.
    const hits = searchKnowledge("axolotl", instanceHome);
    expect(hits.map((h) => h.path)).not.toContain("knowledge/alias.md");
  });

  it("finds notes nested below knowledge/", () => {
    // PLA-52 D1: create_note({ folder }) writes nested files; search must see them.
    const hits = searchKnowledge("newt playbook", instanceHome);
    expect(hits.map((h) => h.path)).toEqual(["knowledge/competitor-scout-2026-07/steal-these-playbook.md"]);
  });

  it("finds documents nested below docs/", () => {
    // PLA-52 D2: the same recursive regime applies to both allowlisted roots.
    const hits = searchKnowledge("newt decision", instanceHome);
    expect(hits.map((h) => h.path)).toEqual(["docs/adr/0001-engine-registry.md"]);
  });

  it("hardens the query: control bytes are separators, hostile/oversized queries return normally", () => {
    const clean = searchKnowledge("axolotl", instanceHome);
    expect(searchKnowledge("axolotl\u0000", instanceHome).map((h) => h.path)).toEqual(clean.map((h) => h.path));
    expect(searchKnowledge("\u0000\u0001\u001f", instanceHome)).toEqual([]);
    expect(searchKnowledge("", instanceHome)).toEqual([]);
    expect(searchKnowledge("   ", instanceHome)).toEqual([]);
    // A 10 KB query is processed deterministically (no throw, no hit).
    expect(searchKnowledge(`zz${"y".repeat(10_000)}`, instanceHome)).toEqual([]);
  });

  it("caps results at the limit, deterministically ordered (matchCount desc, then path)", () => {
    for (let i = 0; i < KNOWLEDGE_SEARCH_LIMIT + 5; i++) {
      seedInstance(`knowledge/bulk-${String(i).padStart(2, "0")}.md`, "# Bulk\n\ncommon-bulk-term here\n");
    }
    const hits = searchKnowledge("common-bulk-term", instanceHome);
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
    const r = readKnowledgeFile("knowledge/pricing-strategy.md", instanceHome);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe("knowledge/pricing-strategy.md");
    expect(r.title).toBe("Pricing strategy 2026");
    expect(r.content).toContain("approved at 19 euro");
    expect(r.truncated).toBe(false);
  });

  it("reads docs/ too", () => {
    const r = readKnowledgeFile("docs/architecture.md", instanceHome);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("gateway daemon");
  });

  it("reads nested and non-Markdown files anywhere inside the instance", () => {
    const nested = readKnowledgeFile("knowledge/competitor-scout-2026-07/steal-these-playbook.md", instanceHome);
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.content).toContain("useful newt pattern");

    const config = readKnowledgeFile("config.yaml", instanceHome);
    expect(config.ok).toBe(true);
    if (config.ok) expect(config.content).toContain("port: 7777");
  });

  it("reads files in other instance directories", () => {
    const r = readKnowledgeFile("secrets/api-keys.json", instanceHome);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("TOPSECRET-zq9");
  });

  it("caps content at KNOWLEDGE_FILE_CHAR_CAP with the intentional-cap marker", () => {
    seedInstance("knowledge/huge.md", `# Huge\n\n${"x".repeat(KNOWLEDGE_FILE_CHAR_CAP + 5_000)}`);
    const r = readKnowledgeFile("knowledge/huge.md", instanceHome);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(KNOWLEDGE_FILE_CHAR_CAP + 200);
    expect(r.content).toMatch(/intentional cap/);
  });

  it("follows a symlink that resolves INSIDE the root", () => {
    const r = readKnowledgeFile("knowledge/alias.md", instanceHome);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("axolotl");
  });
});

describe("readKnowledgeFile — the containment battery (every escape rejected)", () => {
  const rejected = (rel: string, reason?: string) => {
    const r = readKnowledgeFile(rel, instanceHome);
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
    rejected(path.join(instanceHome, "secrets", "api-keys.json"), "invalid-path");
    rejected(path.join(instanceHome, "knowledge", "pricing-strategy.md"), "invalid-path"); // even inside — only relative paths
  });

  it("rejects backslashes and empty path segments", () => {
    rejected("knowledge\\..\\secrets\\api-keys.json", "invalid-path");
    rejected("knowledge/", "invalid-path");
  });

  it("rejects NUL and control bytes outright", () => {
    rejected("knowledge/pricing-strategy.md\u0000", "invalid-path");
    rejected("knowledge/pricing\u0000-strategy.md", "invalid-path");
    rejected("knowledge/foo\u001f.md", "invalid-path");
  });

  it("rejects empty and junk input", () => {
    rejected("", "invalid-path");
    rejected("   ", "invalid-path");
  });

  it("rejects a symlink inside the instance that resolves outside it", () => {
    const r = readKnowledgeFile("knowledge/escape.md", instanceHome);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("forbidden");
    expect(JSON.stringify(r)).not.toContain("TOPSECRET-outside");
  });

  it("404s a missing file (valid shape, nothing there)", () => {
    rejected("knowledge/does-not-exist.md", "not-found");
  });

  it("404s a directory masquerading as a file", () => {
    fs.mkdirSync(path.join(instanceHome, "knowledge", "dir.md"), { recursive: true });
    rejected("knowledge/dir.md", "not-found");
  });
});
