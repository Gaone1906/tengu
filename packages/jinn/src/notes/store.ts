import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "../shared/paths.js";
import { hasControlBytes, stripControlChars } from "../sessions/registry.js";
import type {
  NoteDocument,
  NoteFolder,
  NoteStoreResult,
  NoteSummary,
} from "../shared/types.js";

export type { NoteDocument, NoteFolder, NoteStoreResult, NoteSummary } from "../shared/types.js";

/** Notes are bounded so list/read and MCP calls cannot become context bombs. */
export const NOTE_FILE_MAX_BYTES = 2_000_000;
export const NOTE_PREVIEW_CHAR_CAP = 180;

const PUBLIC_PATH_MAX_CHARS = 1_024;
const TITLE_MAX_CHARS = 240;
const CONTROL_BYTES = /[\x00-\x1f\x7f]/;

type StoreFailure = Extract<NoteStoreResult<never>, { ok: false }>;

interface RootInfo {
  rootPath: string;
  realRoot: string;
}

interface HeadingInfo {
  level: number;
  titleStart: number;
  titleEnd: number;
  headingStart: number;
  tailStart: number;
  eol: string;
}

interface ParsedNote {
  title: string;
  body: string;
  heading?: HeadingInfo;
  /** Frontmatter retained for heading-less notes when their body changes. */
  fallbackPreamble: string;
}

interface ReadFile {
  absolutePath: string;
  bytes: Buffer;
  stat: fs.Stats;
}

function failure(reason: StoreFailure["reason"], detail: string, currentRevision?: string): StoreFailure {
  return { ok: false, reason, detail, ...(currentRevision ? { currentRevision } : {}) };
}

function isFailure<T>(value: T | StoreFailure): value is StoreFailure {
  return typeof value === "object" && value !== null && "ok" in value && (value as StoreFailure).ok === false;
}

function knowledgeRoot(home: string): string {
  return path.join(home, "knowledge");
}

function isRealpathContained(candidate: string, realRoot: string): boolean {
  const relative = path.relative(realRoot, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Recursive Markdown walk shared by {@link listNotes} and {@link searchKnowledge}:
 *  hidden entries, symlinks, realpath escapes, non-Markdown, and oversized files are
 *  skipped; directories descend in stable name order. `onFile` gets the root-relative
 *  path and the lstat-verified absolute path. */
function walkMarkdown(
  absoluteDirectory: string,
  relativeDirectory: string,
  realRoot: string,
  onFile: (relativePath: string, absolutePath: string) => void,
): void {
  let names: string[];
  try {
    names = fs.readdirSync(absoluteDirectory).sort((a, b) => a.localeCompare(b));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name || name.startsWith(".") || name.includes("\\") || CONTROL_BYTES.test(name)) continue;
    const absolutePath = path.join(absoluteDirectory, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    let realPath: string;
    try {
      realPath = fs.realpathSync(absolutePath);
    } catch {
      continue;
    }
    if (!isRealpathContained(realPath, realRoot)) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    if (stat.isDirectory()) {
      walkMarkdown(absolutePath, relativePath, realRoot, onFile);
      continue;
    }
    if (!stat.isFile() || !name.endsWith(".md") || stat.size > NOTE_FILE_MAX_BYTES) continue;
    onFile(relativePath, absolutePath);
  }
}

function resolveRoot(home: string, create: boolean): RootInfo | StoreFailure {
  const rootPath = knowledgeRoot(home);
  try {
    let rootStat: fs.Stats;
    try {
      rootStat = fs.lstatSync(rootPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return failure("not-found", "the knowledge/ directory does not exist");
      fs.mkdirSync(rootPath, { recursive: false, mode: 0o700 });
      rootStat = fs.lstatSync(rootPath);
    }
    if (rootStat.isSymbolicLink()) {
      return failure("forbidden", "the knowledge/ root is a symlink and cannot be used as the Notes store");
    }
    if (!rootStat.isDirectory()) return failure("forbidden", "the knowledge/ root is not a directory");
    return { rootPath, realRoot: fs.realpathSync(rootPath) };
  } catch (error) {
    return failure("forbidden", `could not access the knowledge/ root: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function invalidPathDetail(kind: "path" | "folder"): string {
  return kind === "path"
    ? 'path must be a safe relative Markdown path below knowledge/, for example "knowledge/product/brief.md"'
    : 'folder must be a safe knowledge-relative directory, for example "product/research"';
}

function safeSegments(value: string, kind: "path" | "folder"): string[] | StoreFailure {
  if (typeof value !== "string" || value.length > PUBLIC_PATH_MAX_CHARS || CONTROL_BYTES.test(value) || value.includes("\\")) {
    return failure("invalid-path", invalidPathDetail(kind));
  }
  if (kind === "folder" && value === "") return [];
  if (!value || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    return failure("invalid-path", invalidPathDetail(kind));
  }
  const publicRelative = kind === "path"
    ? (value.startsWith("knowledge/") ? value.slice("knowledge/".length) : "")
    : value;
  const segments = publicRelative.split("/");
  if (
    !publicRelative
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || CONTROL_BYTES.test(segment))
    || (kind === "path" && (!segments.at(-1)?.endsWith(".md") || segments.at(-1) === ".md"))
  ) {
    return failure("invalid-path", invalidPathDetail(kind));
  }
  return segments;
}

function walkExisting(root: RootInfo, segments: string[]): string | StoreFailure {
  let current = root.rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return failure("not-found", `no such note: knowledge/${segments.join("/")}`);
      }
      return failure("forbidden", `could not inspect knowledge/${segments.slice(0, index + 1).join("/")}`);
    }
    if (stat.isSymbolicLink()) {
      return failure("forbidden", `knowledge/${segments.slice(0, index + 1).join("/")} is a symlink`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return failure("not-found", `knowledge/${segments.slice(0, index + 1).join("/")} is not a directory`);
    }
    let realCurrent: string;
    try {
      realCurrent = fs.realpathSync(current);
    } catch {
      return failure("forbidden", `could not resolve knowledge/${segments.slice(0, index + 1).join("/")}`);
    }
    if (!isRealpathContained(realCurrent, root.realRoot)) {
      return failure("forbidden", `knowledge/${segments.slice(0, index + 1).join("/")} resolves outside knowledge/`);
    }
  }
  return current;
}

function ensureFolder(root: RootInfo, segments: string[]): string | StoreFailure {
  let current = root.rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return failure("forbidden", `could not inspect folder ${segments.slice(0, index + 1).join("/")}`);
      }
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        stat = fs.lstatSync(current);
      } catch (mkdirError) {
        return failure("forbidden", `could not create folder ${segments.slice(0, index + 1).join("/")}: ${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}`);
      }
    }
    if (stat.isSymbolicLink()) return failure("forbidden", `folder ${segments.slice(0, index + 1).join("/")} is a symlink`);
    if (!stat.isDirectory()) return failure("forbidden", `folder ${segments.slice(0, index + 1).join("/")} is not a directory`);
    const realCurrent = fs.realpathSync(current);
    if (!isRealpathContained(realCurrent, root.realRoot)) {
      return failure("forbidden", `folder ${segments.slice(0, index + 1).join("/")} resolves outside knowledge/`);
    }
  }
  return current;
}

function openRegularFile(absolutePath: string): ReadFile | StoreFailure {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return failure("not-found", `${absolutePath} is not a regular file`);
    if (stat.size > NOTE_FILE_MAX_BYTES) {
      return failure("too-large", `note is too large (${stat.size} bytes, max ${NOTE_FILE_MAX_BYTES})`);
    }
    return { absolutePath, bytes: fs.readFileSync(descriptor), stat };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return failure("forbidden", `${absolutePath} is a symlink`);
    if (code === "ENOENT") return failure("not-found", `no such note: ${absolutePath}`);
    return failure("forbidden", `could not read note: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function stripOneTrailingEol(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : /[\n\r]$/.test(value) ? value.slice(0, -1) : value;
}

function editableBody(tail: string): string {
  let body = tail;
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n") || body.startsWith("\r")) body = body.slice(1);
  return stripOneTrailingEol(body);
}

function frontmatterPreamble(raw: string): string {
  const firstEol = raw.indexOf("\n");
  if (firstEol < 0 || raw.slice(0, firstEol).replace(/\r$/, "") !== "---") return "";
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  linePattern.lastIndex = firstEol + 1;
  while (linePattern.lastIndex < raw.length) {
    const match = linePattern.exec(raw);
    if (!match) break;
    if (match[1] === "---" || match[1] === "...") {
      let end = linePattern.lastIndex;
      const blank = /^(\r\n|\n|\r)/.exec(raw.slice(end));
      if (blank) end += blank[0].length;
      return raw.slice(0, end);
    }
    if (match[2] === "") break;
  }
  return "";
}

function parseNote(raw: string, fallbackTitle: string): ParsedNote {
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let inFence: { marker: string; length: number } | undefined;
  while (linePattern.lastIndex < raw.length) {
    const headingStart = linePattern.lastIndex;
    const line = linePattern.exec(raw);
    if (!line) break;
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line[1]);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) inFence = { marker, length: fence[1].length };
      else if (inFence.marker === marker && fence[1].length >= inFence.length) inFence = undefined;
    } else if (!inFence) {
      const heading = /^(#{1,6})([ \t]+)(.*?)([ \t]*)$/.exec(line[1]);
      if (heading && heading[3].trim()) {
        const titleStart = headingStart + heading[1].length + heading[2].length;
        const titleEnd = titleStart + heading[3].length;
        return {
          title: heading[3].trim(),
          body: editableBody(raw.slice(linePattern.lastIndex)),
          heading: {
            level: heading[1].length,
            titleStart,
            titleEnd,
            headingStart,
            tailStart: linePattern.lastIndex,
            eol: line[2],
          },
          fallbackPreamble: "",
        };
      }
    }
    if (line[2] === "") break;
  }

  const fallbackPreamble = frontmatterPreamble(raw);
  return {
    title: fallbackTitle,
    body: stripOneTrailingEol(raw.slice(fallbackPreamble.length)),
    fallbackPreamble,
  };
}

function plainTextPreview(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > NOTE_PREVIEW_CHAR_CAP ? `${plain.slice(0, NOTE_PREVIEW_CHAR_CAP - 1)}…` : plain;
}

function revisionOf(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function documentFromFile(publicPath: string, file: ReadFile): NoteDocument {
  const folder = path.posix.dirname(publicPath.slice("knowledge/".length));
  const normalizedFolder = folder === "." ? "" : folder;
  const fallbackTitle = path.posix.basename(publicPath, ".md");
  const parsed = parseNote(file.bytes.toString("utf-8"), fallbackTitle);
  return {
    path: publicPath,
    title: parsed.title,
    preview: plainTextPreview(parsed.body),
    folder: normalizedFolder,
    updatedAt: file.stat.mtime.toISOString(),
    revision: revisionOf(file.bytes),
    body: parsed.body,
  };
}

function readValidated(publicPath: string, home: string): NoteStoreResult<{ document: NoteDocument; file: ReadFile; parsed: ParsedNote }> {
  const segments = safeSegments(publicPath, "path");
  if (isFailure(segments)) return segments;
  const root = resolveRoot(home, false);
  if (isFailure(root)) return root;
  const absolutePath = walkExisting(root, segments);
  if (isFailure(absolutePath)) return absolutePath;
  const file = openRegularFile(absolutePath);
  if (isFailure(file)) return file;
  const document = documentFromFile(publicPath, file);
  return {
    ok: true,
    value: {
      document,
      file,
      parsed: parseNote(file.bytes.toString("utf-8"), path.posix.basename(publicPath, ".md")),
    },
  };
}

export function listNotes(options: { query?: string; home?: string } = {}): { notes: NoteSummary[]; folders: NoteFolder[] } {
  const home = options.home ?? JINN_HOME;
  const root = resolveRoot(home, false);
  if (isFailure(root)) return { notes: [], folders: [] };
  const query = typeof options.query === "string"
    ? options.query.replace(CONTROL_BYTES, " ").trim().toLocaleLowerCase()
    : "";
  const notes: NoteSummary[] = [];

  walkMarkdown(root.rootPath, "", root.realRoot, (relativePath, absolutePath) => {
    const publicPath = `knowledge/${relativePath}`;
    if (isFailure(safeSegments(publicPath, "path"))) return;
    const file = openRegularFile(absolutePath);
    if (isFailure(file)) return;
    const { body, ...summary } = documentFromFile(publicPath, file);
    if (query && !`${summary.title}\n${summary.path}\n${body}`.toLocaleLowerCase().includes(query)) return;
    notes.push(summary);
  });
  notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));

  const folderCounts = new Map<string, number>();
  for (const note of notes) {
    if (!note.folder) continue;
    const segments = note.folder.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const folderPath = segments.slice(0, index).join("/");
      folderCounts.set(folderPath, (folderCounts.get(folderPath) ?? 0) + 1);
    }
  }
  const folders = [...folderCounts.entries()]
    .map(([folderPath, count]) => ({ path: folderPath, name: path.posix.basename(folderPath), count }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { notes, folders };
}

export function readNote(notePath: string, home: string = JINN_HOME): NoteStoreResult<NoteDocument> {
  const result = readValidated(notePath, home);
  return result.ok ? { ok: true, value: result.value.document } : result;
}

function validTitle(value: unknown): string | StoreFailure {
  if (typeof value !== "string") return failure("invalid-path", "title is required and must be a string");
  const title = value.trim();
  if (!title || title.length > TITLE_MAX_CHARS || CONTROL_BYTES.test(title)) {
    return failure("invalid-path", `title must be 1-${TITLE_MAX_CHARS} characters on one line`);
  }
  return title;
}

function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "note";
}

function renderCreated(title: string, body: string): Buffer {
  const normalizedBody = stripOneTrailingEol(body);
  return Buffer.from(`# ${title}\n${normalizedBody ? `\n${normalizedBody}\n` : ""}`, "utf-8");
}

function writeExclusive(absolutePath: string, bytes: Buffer): StoreFailure | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(absolutePath, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    return undefined;
  } catch (error) {
    try {
      if (fs.lstatSync(absolutePath).isSymbolicLink()) return failure("forbidden", `${absolutePath} is a symlink`);
    } catch {
      // The target still does not exist; surface the original write failure.
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return failure("already-exists", `${absolutePath} already exists`);
    return failure("forbidden", `could not create note: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createNote(
  input: { title: string; body?: string; folder?: string },
  home: string = JINN_HOME,
): NoteStoreResult<NoteDocument> {
  const title = validTitle(input?.title);
  if (isFailure(title)) return title;
  if (input.body !== undefined && typeof input.body !== "string") return failure("invalid-path", "body must be a string");
  const folder = input.folder ?? "";
  const folderSegments = safeSegments(folder, "folder");
  if (isFailure(folderSegments)) return folderSegments;
  const root = resolveRoot(home, true);
  if (isFailure(root)) return root;
  const absoluteFolder = ensureFolder(root, folderSegments);
  if (isFailure(absoluteFolder)) return absoluteFolder;
  const bytes = renderCreated(title, input.body ?? "");
  if (bytes.length > NOTE_FILE_MAX_BYTES) {
    return failure("too-large", `note is too large (${bytes.length} bytes, max ${NOTE_FILE_MAX_BYTES})`);
  }

  const baseSlug = slugify(title);
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const name = `${baseSlug}${suffix === 1 ? "" : `-${suffix}`}.md`;
    const absolutePath = path.join(absoluteFolder, name);
    try {
      const existing = fs.lstatSync(absolutePath);
      if (existing.isSymbolicLink()) return failure("forbidden", `knowledge/${[...folderSegments, name].join("/")} is a symlink`);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return failure("forbidden", `could not inspect destination knowledge/${[...folderSegments, name].join("/")}`);
      }
    }
    const writeFailure = writeExclusive(absolutePath, bytes);
    if (writeFailure?.reason === "already-exists") continue;
    if (writeFailure) return writeFailure;
    const publicPath = `knowledge/${[...folderSegments, name].join("/")}`;
    return readNote(publicPath, home);
  }
  return failure("already-exists", `could not allocate a unique filename for "${title}"`);
}

function detectEol(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : raw.includes("\n") ? "\n" : raw.includes("\r") ? "\r" : "\n";
}

function renderBody(preamble: string, heading: string | undefined, body: string, eol: string): Buffer {
  const normalizedBody = stripOneTrailingEol(body);
  const renderedHeading = heading ? `${heading}${eol}` : "";
  const separator = renderedHeading && normalizedBody ? eol : "";
  const tail = normalizedBody ? `${normalizedBody}${eol}` : "";
  return Buffer.from(`${preamble}${renderedHeading}${separator}${tail}`, "utf-8");
}

function renderUpdated(
  raw: string,
  parsed: ParsedNote,
  input: { title?: string; body?: string; append?: string },
): Buffer | StoreFailure {
  let title: string | undefined;
  if (input.title !== undefined) {
    const checked = validTitle(input.title);
    if (isFailure(checked)) return checked;
    title = checked;
  }
  if (input.body !== undefined && typeof input.body !== "string") return failure("invalid-path", "body must be a string");
  if (input.append !== undefined && typeof input.append !== "string") return failure("invalid-path", "append must be a string");
  if (input.body !== undefined && input.append !== undefined) {
    return failure("invalid-path", "body and append are mutually exclusive");
  }
  if (title === undefined && input.body === undefined && input.append === undefined) {
    return failure("invalid-path", "at least one of title, body, or append is required");
  }

  if (parsed.heading && input.body === undefined && input.append === undefined && title !== undefined) {
    return Buffer.from(`${raw.slice(0, parsed.heading.titleStart)}${title}${raw.slice(parsed.heading.titleEnd)}`, "utf-8");
  }

  const eol = parsed.heading?.eol || detectEol(raw);
  let body = input.body ?? parsed.body;
  if (input.append !== undefined) body = parsed.body ? `${parsed.body}${eol}${eol}${input.append}` : input.append;
  if (parsed.heading) {
    const preamble = raw.slice(0, parsed.heading.headingStart);
    const heading = `${"#".repeat(parsed.heading.level)} ${title ?? parsed.title}`;
    return renderBody(preamble, heading, body, eol);
  }
  const heading = title === undefined ? undefined : `# ${title}`;
  return renderBody(parsed.fallbackPreamble, heading, body, eol);
}

function atomicReplace(absolutePath: string, bytes: Buffer, mode: number): StoreFailure | undefined {
  const directory = path.dirname(absolutePath);
  const temporaryPath = path.join(directory, `.${path.basename(absolutePath)}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode & 0o777);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, absolutePath);
    return undefined;
  } catch (error) {
    return failure("forbidden", `could not atomically update note: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Successful rename removes the temporary name; failed writes are cleaned up.
    }
  }
}

export function updateNote(
  input: { path: string; expectedRevision: string; title?: string; body?: string; append?: string },
  home: string = JINN_HOME,
): NoteStoreResult<NoteDocument> {
  if (!input || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    return failure("invalid-path", "expectedRevision is required and must be a SHA-256 revision returned by read_note");
  }
  const current = readValidated(input.path, home);
  if (!current.ok) return current;
  if (current.value.document.revision !== input.expectedRevision) {
    return failure(
      "conflict",
      "the note changed since it was read; read it again before updating",
      current.value.document.revision,
    );
  }
  const bytes = renderUpdated(current.value.file.bytes.toString("utf-8"), current.value.parsed, input);
  if (isFailure(bytes)) return bytes;
  if (bytes.length > NOTE_FILE_MAX_BYTES) {
    return failure("too-large", `note is too large (${bytes.length} bytes, max ${NOTE_FILE_MAX_BYTES})`);
  }
  const writeFailure = atomicReplace(current.value.file.absolutePath, bytes, current.value.file.stat.mode);
  if (writeFailure) return writeFailure;
  return readNote(input.path, home);
}

/* ── Knowledge search + instance read (GRS-020b, re-homed here by PLA-52) ────
 *
 * Deterministic search over the company's institutional knowledge, plus capped reads
 * of files in the active Jinn instance. Search walks knowledge/ and docs/ through
 * {@link walkMarkdown} — the same recursive, symlink-refusing regime the Notes surface
 * above uses — so nested notes are findable and one module owns the directory. No LLM
 * anywhere: case-insensitive token-AND matching (every whitespace token must appear in
 * the relative path or the content), FTS-style «»-marked ~12-word snippets, never file
 * bodies. Query hardening reuses the shared {@link stripControlChars} (GRS-020a-fix
 * finding 2) so hostile encoded input degrades to an empty result, never an error.
 */

/** Context-bomb guards: hit count, snippet chars, read chars, snippet word window. */
export const KNOWLEDGE_SEARCH_LIMIT = 20;
export const KNOWLEDGE_SNIPPET_CHAR_CAP = 300;
export const KNOWLEDGE_FILE_CHAR_CAP = 20_000;
const SNIPPET_WORDS_EACH_SIDE = 6;
/** The allowlisted search roots — the ONLY directories search will ever touch. */
const SEARCH_ROOTS = ["knowledge", "docs"] as const;

export interface KnowledgeSearchHit {
  /** Relative path, e.g. `knowledge/pricing-strategy.md` — feed to readKnowledgeFile. */
  path: string;
  /** First markdown heading, else the filename. */
  title: string;
  /** ~12-word window around the first match, matched token wrapped in «». */
  snippet: string;
  /** Total occurrences of all query tokens across path + content. */
  matchCount: number;
}

export type KnowledgeReadResult =
  | { ok: true; path: string; title: string; content: string; truncated: boolean; totalChars: number }
  | { ok: false; reason: "invalid-path" | "forbidden" | "not-found"; detail: string };

function firstHeading(content: string, fallback: string): string {
  for (const line of content.split("\n", 50)) {
    const m = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return fallback;
}

/** Non-overlapping occurrences of `needle` in `hay`. */
function countOccurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** FTS-style snippet: up to {@link SNIPPET_WORDS_EACH_SIDE} words each side of the
 *  first content match, the matched token «»-wrapped, ellipses at cut edges. */
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

/** A file matches when EVERY query token appears in its relative path or content.
 *  Results: `matchCount` desc, then path asc, capped at {@link KNOWLEDGE_SEARCH_LIMIT}.
 *  Snippets only — never bodies. Symlinks and realpath escapes are skipped
 *  entirely, so their content can't leak. */
export function searchKnowledge(query: string, home: string = JINN_HOME): KnowledgeSearchHit[] {
  const tokens = [...new Set(stripControlChars(query).toLowerCase().split(/\s+/).filter(Boolean))];
  if (tokens.length === 0) return [];

  const hits: KnowledgeSearchHit[] = [];
  for (const label of SEARCH_ROOTS) {
    const rootPath = path.join(home, label);
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(rootPath);
    } catch {
      continue;
    }
    walkMarkdown(rootPath, "", realRoot, (relativePath, absolutePath) => {
      const relPath = `${label}/${relativePath}`;
      const file = openRegularFile(absolutePath);
      if (isFailure(file)) return;
      const content = file.bytes.toString("utf-8");
      const lowerContent = content.toLowerCase();
      const lowerPath = relPath.toLowerCase();
      if (!tokens.every((t) => lowerContent.includes(t) || lowerPath.includes(t))) return;

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
        title: firstHeading(content, path.posix.basename(relativePath)),
        snippet: firstIdx === -1 ? fallbackSnippet(content) : makeSnippet(content, firstIdx, firstLen),
        matchCount,
      });
    });
  }

  hits.sort((a, b) => b.matchCount - a.matchCount || a.path.localeCompare(b.path));
  return hits.slice(0, KNOWLEDGE_SEARCH_LIMIT);
}

/** Read ONE file inside the active Jinn instance by relative path.
 *  SECURITY-CRITICAL: the path must be normalized and its realpath must resolve
 *  inside the realpath of the instance root. Traversal, absolute paths, control
 *  bytes, and symlink escapes are refused; content is capped at
 *  {@link KNOWLEDGE_FILE_CHAR_CAP} with the intentional-cap marker. */
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
  const traversal = segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (relPath !== relPath.trim() || path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || relPath.includes("\\") || traversal) {
    const shown = JSON.stringify(relPath.slice(0, 120));
    return { ok: false, reason: "invalid-path", detail: `path must be a normalized relative path inside the Jinn instance — got ${shown}` };
  }

  let realHome: string;
  let realFile: string;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    return { ok: false, reason: "not-found", detail: "the Jinn instance directory does not exist" };
  }
  try {
    realFile = fs.realpathSync(path.join(home, ...segments));
  } catch {
    return { ok: false, reason: "not-found", detail: `no such instance file: ${relPath}` };
  }
  if (realFile === realHome || !isRealpathContained(realFile, realHome)) {
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
