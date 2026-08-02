import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "../shared/paths.js";
import { stripControlChars, hasControlBytes } from "../shared/sanitize.js";

/**
 * GRS-020b — deterministic search over the company's institutional knowledge
 * plus capped reads of files in the active Jinn instance. This is the FIRST
 * filesystem-reading primitive on the MCP belt, so reads retain one hard rule:
 *
 *   - A read path must be relative and REALPATH-resolve inside the realpath of
 *     the instance root. Traversal, absolute paths, control bytes, and symlink
 *     escapes are rejected.
 *   - Search remains scoped to flat Markdown files in knowledge/ and docs/ and
 *     applies the same per-search-root realpath check before scanning a file.
 *
 * No LLM anywhere: search is case-insensitive token-AND matching (every
 * whitespace token of the query must appear in the filename or content), with
 * FTS-style «»-marked ~12-word snippets — never file bodies. Query hardening
 * reuses the shared {@link stripControlChars} (GRS-020a-fix finding 2) so
 * hostile encoded input degrades to a normal empty result, never an error.
 */

/* ── Caps (design §3 context-bomb guards) ──────────────────────────────────── */

/** Max search hits returned. */
export const KNOWLEDGE_SEARCH_LIMIT = 20;
/** Defensive per-snippet char cap (the word window is ~12 tokens already). */
export const KNOWLEDGE_SNIPPET_CHAR_CAP = 300;
/** Read cap — a knowledge doc excerpt, not an unbounded file dump. */
export const KNOWLEDGE_FILE_CHAR_CAP = 20_000;
/** Words kept on each side of the first match in a snippet. */
const SNIPPET_WORDS_EACH_SIDE = 6;
/** Files larger than this are skipped by search (deterministic cost bound). */
const SEARCH_FILE_MAX_BYTES = 2_000_000;

/** The allowlisted roots — the ONLY directories this module will ever touch. */
const ROOT_LABELS = ["knowledge", "docs"] as const;
export type KnowledgeRootLabel = (typeof ROOT_LABELS)[number];

/** Search-only `<root-label>/<flat-file-name>.md` gate — one separator, conservative name
 *  charset (no spaces, no further separators, so `..` can never be a path
 *  SEGMENT), lowercase `.md` only. The realpath check below is the authority;
 *  this gate just refuses garbage cheaply and readably. */
const SEARCH_REL_PATH_PATTERN = /^(knowledge|docs)\/[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.md$/;

function rootDir(home: string, label: KnowledgeRootLabel): string {
  return path.join(home, label);
}

export interface KnowledgeSearchHit {
  /** Relative path, e.g. `knowledge/pricing-strategy.md` — feed to readKnowledgeFile. */
  path: string;
  /** First markdown heading, else the filename. */
  title: string;
  /** ~12-word window around the first match, matched token wrapped in «». */
  snippet: string;
  /** Total occurrences of all query tokens across filename + content. */
  matchCount: number;
}

export type KnowledgeReadResult =
  | { ok: true; path: string; title: string; content: string; truncated: boolean; totalChars: number }
  | { ok: false; reason: "invalid-path" | "forbidden" | "not-found"; detail: string };

/* ── Internal helpers ──────────────────────────────────────────────────────── */

function firstHeading(content: string, fallback: string): string {
  for (const line of content.split("\n", 50)) {
    const m = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return fallback;
}

/** Realpath containment: `file` (already realpath'd) must live inside the
 *  realpath of `dir`. Symlink-escape safe on both sides (a symlinked ROOT is
 *  fine — containment is measured against what it resolves to). */
function isInsideReal(realFile: string, realRoot: string): boolean {
  return realFile.startsWith(realRoot + path.sep);
}

/** Resolve a root's realpath, or null when the directory doesn't exist. */
function realRootOf(home: string, label: KnowledgeRootLabel): string | null {
  try {
    const real = fs.realpathSync(rootDir(home, label));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function countOccurrences(hay: string, needle: string): number {
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** FTS-style snippet: up to {@link SNIPPET_WORDS_EACH_SIDE} words each side of
 *  the first content match, the matched token «»-wrapped, ellipses at cut
 *  edges. Filename-only matches fall back to the first non-heading line. */
function makeSnippet(content: string, matchIdx: number, matchLen: number): string {
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const before = collapse(content.slice(Math.max(0, matchIdx - 400), matchIdx));
  const match = content.slice(matchIdx, matchIdx + matchLen);
  const after = collapse(content.slice(matchIdx + matchLen, matchIdx + matchLen + 400));
  const preWords = before.split(" ").filter(Boolean);
  const postWords = after.split(" ").filter(Boolean);
  const pre = preWords.slice(-SNIPPET_WORDS_EACH_SIDE);
  const post = postWords.slice(0, SNIPPET_WORDS_EACH_SIDE);
  const parts = [
    matchIdx > 0 && (preWords.length > SNIPPET_WORDS_EACH_SIDE || pre.length === 0) ? "…" : "",
    pre.join(" "),
    `«${match}»`,
    post.join(" "),
    postWords.length > SNIPPET_WORDS_EACH_SIDE ? "…" : "",
  ].filter(Boolean);
  const snippet = parts.join(" ");
  return snippet.length > KNOWLEDGE_SNIPPET_CHAR_CAP ? `${snippet.slice(0, KNOWLEDGE_SNIPPET_CHAR_CAP - 1)}…` : snippet;
}

function fallbackSnippet(content: string): string {
  for (const line of content.split("\n", 50)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) {
      return t.length > KNOWLEDGE_SNIPPET_CHAR_CAP ? `${t.slice(0, KNOWLEDGE_SNIPPET_CHAR_CAP - 1)}…` : t;
    }
  }
  return "";
}

/* ── Search ────────────────────────────────────────────────────────────────── */

/**
 * Deterministic case-insensitive token-AND search across the two allowlisted
 * roots. A file matches when EVERY query token appears in its relative path or
 * content. Results: `matchCount` desc, then path asc, capped at
 * {@link KNOWLEDGE_SEARCH_LIMIT}. Snippets only — never bodies. Files whose
 * realpath escapes their root (symlinks out) are skipped entirely, so their
 * content can't leak through a snippet.
 */
export function searchKnowledge(query: string, home: string = JINN_HOME): KnowledgeSearchHit[] {
  const tokens = [...new Set(stripControlChars(query).toLowerCase().split(/\s+/).filter(Boolean))];
  if (tokens.length === 0) return [];

  const hits: KnowledgeSearchHit[] = [];
  for (const label of ROOT_LABELS) {
    const realRoot = realRootOf(home, label);
    if (!realRoot) continue;
    let names: string[];
    try {
      names = fs.readdirSync(rootDir(home, label)).filter((n) => n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const relPath = `${label}/${name}`;
      if (!SEARCH_REL_PATH_PATTERN.test(relPath)) continue; // odd names never enter the surface
      let realFile: string;
      try {
        realFile = fs.realpathSync(path.join(rootDir(home, label), name));
        const stat = fs.statSync(realFile);
        if (!stat.isFile() || stat.size > SEARCH_FILE_MAX_BYTES) continue;
      } catch {
        continue;
      }
      if (!isInsideReal(realFile, realRoot)) continue; // scoped-root invariant, search side
      let content: string;
      try {
        content = fs.readFileSync(realFile, "utf-8");
      } catch {
        continue;
      }
      const lowerContent = content.toLowerCase();
      const lowerPath = relPath.toLowerCase();
      if (!tokens.every((t) => lowerContent.includes(t) || lowerPath.includes(t))) continue;

      let matchCount = 0;
      let firstIdx = -1;
      let firstLen = 0;
      for (const t of tokens) {
        matchCount += countOccurrences(lowerContent, t) + countOccurrences(lowerPath, t);
        const idx = lowerContent.indexOf(t);
        if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
          firstIdx = idx;
          firstLen = t.length;
        }
      }
      hits.push({
        path: relPath,
        title: firstHeading(content, name),
        snippet: firstIdx === -1 ? fallbackSnippet(content) : makeSnippet(content, firstIdx, firstLen),
        matchCount,
      });
    }
  }

  hits.sort((a, b) => b.matchCount - a.matchCount || a.path.localeCompare(b.path));
  return hits.slice(0, KNOWLEDGE_SEARCH_LIMIT);
}

/* ── Read ──────────────────────────────────────────────────────────────────── */

/**
 * Read ONE file inside the active Jinn instance by relative path.
 * SECURITY-CRITICAL: the path must be normalized and its realpath must resolve
 * inside the realpath of the instance root. Traversal, absolute paths, control
 * bytes, and symlink escapes are refused; content is capped at
 * {@link KNOWLEDGE_FILE_CHAR_CAP} with the intentional-cap marker.
 */
export function readKnowledgeFile(relPath: string, home: string = JINN_HOME): KnowledgeReadResult {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 300) {
    return { ok: false, reason: "invalid-path", detail: "path must be a relative path inside the Jinn instance" };
  }
  // GRS-020b-fix: REJECT (never strip) control bytes on the raw path — the
  // store is the defense-in-depth backstop so no caller (route or MCP tool)
  // can strip-then-accept a %00-tampered path into a valid one.
  if (hasControlBytes(relPath)) {
    return { ok: false, reason: "invalid-path", detail: "path contains control bytes" };
  }
  const segments = relPath.split("/");
  if (
    relPath !== relPath.trim() ||
    path.isAbsolute(relPath) ||
    path.win32.isAbsolute(relPath) ||
    relPath.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return {
      ok: false,
      reason: "invalid-path",
      detail: `path must be a normalized relative path inside the Jinn instance — got ${JSON.stringify(relPath.slice(0, 120))}`,
    };
  }

  let realHome: string;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    return { ok: false, reason: "not-found", detail: "the Jinn instance directory does not exist" };
  }

  let realFile: string;
  try {
    realFile = fs.realpathSync(path.join(home, ...segments));
  } catch {
    return { ok: false, reason: "not-found", detail: `no such instance file: ${relPath}` };
  }
  if (!isInsideReal(realFile, realHome)) {
    return { ok: false, reason: "forbidden", detail: `${relPath} resolves outside the Jinn instance and is not readable` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realFile);
  } catch {
    return { ok: false, reason: "not-found", detail: `no such instance file: ${relPath}` };
  }
  if (!stat.isFile()) return { ok: false, reason: "not-found", detail: `${relPath} is not a regular file` };

  let content: string;
  try {
    content = fs.readFileSync(realFile, "utf-8");
  } catch {
    return { ok: false, reason: "not-found", detail: `could not read ${relPath}` };
  }
  const totalChars = content.length;
  const truncated = totalChars > KNOWLEDGE_FILE_CHAR_CAP;
  if (truncated) {
    content =
      content.slice(0, KNOWLEDGE_FILE_CHAR_CAP) +
      `…[truncated ${totalChars - KNOWLEDGE_FILE_CHAR_CAP} chars — intentional cap; this is an instance file excerpt]`;
  }
  return { ok: true, path: relPath, title: firstHeading(content, path.basename(relPath)), content, truncated, totalChars };
}
