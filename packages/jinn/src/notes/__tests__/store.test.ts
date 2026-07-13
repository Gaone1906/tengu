import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NOTE_FILE_MAX_BYTES,
  createNote,
  listNotes,
  readNote,
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
