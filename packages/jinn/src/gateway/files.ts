import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import Busboy from "busboy";
import { FILES_DIR, UPLOADS_DIR, JINN_HOME } from "../shared/paths.js";
import { resolveClaudeConfigDir } from "../shared/home.js";
import { logger } from "../shared/logger.js";
import { redactText } from "../shared/redact.js";
import { insertFile, getFile, getSession, listFiles, deleteFile, setFilePath, insertMessage, type FileMeta, type MessageMedia } from "../sessions/registry.js";
import { hasControlBytes } from "../shared/sanitize.js";
import type { ApiContext } from "./api.js";
import { CALLER_SESSION_HEADER, TOOL_CALL_HEADER, UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from "../mcp/identity.js";
import { resolveCallerIdentity } from "./session-comm-guards.js";
import { verifyGatewayAuth } from "./auth.js";

// Ensure managed files directory exists
export function ensureFilesDir(): void {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Upload path safety helpers ───────────────────────────────────

/** Strip any directory components from an uploaded filename (path-traversal guard). */
export function sanitizeUploadFilename(name: string): string {
  // basename drops directory parts; also handle backslashes some clients send.
  const base = path.basename(String(name ?? "").replace(/\\/g, "/")).trim();
  // Reject "", ".", ".." and anything that's only dots.
  if (!base || /^\.+$/.test(base)) return "file";
  return base;
}

/** Restrict a sessionId to a safe single path segment (no separators / traversal). */
export function sanitizeSessionId(id: string): string {
  // Drop separators/unsafe chars, then strip leading dots so no "."/".." segment survives.
  const cleaned = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "");
  if (!cleaned) return "unknown";
  return cleaned;
}

/** Today's date bucket (UTC) as YYYY-MM-DD. */
function todayBucket(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Date-bucketed, session-scoped upload directory under UPLOADS_DIR. */
export function uploadDir(sessionId: string, date?: string): string {
  const bucket = date || todayBucket();
  return path.join(UPLOADS_DIR, bucket, sanitizeSessionId(sessionId));
}

/** True only when absPath resolves inside FILES_DIR or UPLOADS_DIR (no arbitrary reads). */
export function isServablePath(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  return [FILES_DIR, UPLOADS_DIR].some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

export function resolveCustomUploadPath(requestedPath: string | null | undefined): string | null {
  if (!requestedPath) return null;
  const resolved = path.resolve(expandPath(requestedPath));
  return isServablePath(resolved) ? resolved : null;
}

function allowCustomUploadPaths(context: ApiContext): boolean {
  return context.getConfig().gateway?.allowFileCustomPaths === true;
}

export function allowUploadedFileOpen(context: Pick<ApiContext, "getConfig">): boolean {
  return context.getConfig().gateway?.allowFileOpen === true;
}

class FileRequestError extends Error {}

function rejectUnidentifiedToolCaller(req: HttpRequest, res: ServerResponse): boolean {
  if (!req.headers[TOOL_CALL_HEADER] && !req.headers[CALLER_SESSION_HEADER]) return false;
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
  });
  if (identity.kind !== "unidentified-tool") return false;
  json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
  return true;
}

function requireOperatorFileAuthority(req: HttpRequest, res: ServerResponse, action: string, context: ApiContext): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated: verifyGatewayAuth(req.headers, context.gatewayAuthToken, context.jinnHome ?? JINN_HOME),
  });
  if (identity.kind === "unidentified-tool" || identity.kind === "unauthenticated") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return false;
  }
  if (identity.kind === "session") {
    json(res, { error: `${action} is operator-only; capability-bound sessions cannot read, transfer, or delete local gateway files` }, 403);
    return false;
  }
  return true;
}

function stripTrailingDots(host: string): string {
  return host.replace(/\.+$/g, "");
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts as [number, number, number, number];
}

function ipv4FromMappedIpv6(host: string): string | null {
  const lower = host.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const compatibleDotted = /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (compatibleDotted) return compatibleDotted[1];
  const hex = /^(?:::ffff:|0:0:0:0:0:ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function privateIpReason(address: string): string | null {
  const host = stripTrailingDots(address.toLowerCase().replace(/^\[|\]$/g, ""));
  const mapped = ipv4FromMappedIpv6(host);
  const ipv4 = parseIpv4(mapped ?? host);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (a === 0 || a === 10 || a === 127) return "loopback or private URLs are not fetchable";
    if (a === 100 && b >= 64 && b <= 127) return "private URLs are not fetchable";
    if (a === 169 && b === 254) return "link-local URLs are not fetchable";
    if (a === 172 && b >= 16 && b <= 31) return "private URLs are not fetchable";
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return "non-public URLs are not fetchable";
    if (a === 192 && b === 88 && c === 99) return "non-public URLs are not fetchable";
    if (a === 192 && b === 168) return "private URLs are not fetchable";
    if (a === 198 && (b === 18 || b === 19)) return "private URLs are not fetchable";
    if (a === 198 && b === 51 && c === 100) return "non-public URLs are not fetchable";
    if (a === 203 && b === 0 && c === 113) return "non-public URLs are not fetchable";
    if (a >= 224) return "non-public URLs are not fetchable";
    return null;
  }
  if (net.isIP(host) === 6) {
    if (host === "::" || host === "::1" || host === "0:0:0:0:0:0:0:0" || host === "0:0:0:0:0:0:0:1") {
      return "loopback URLs are not fetchable";
    }
    if (/^f[cd][0-9a-f]*:/i.test(host)) return "private URLs are not fetchable";
    if (/^fe[89ab][0-9a-f]*:/i.test(host)) return "link-local URLs are not fetchable";
    if (/^ff[0-9a-f]*:/i.test(host)) return "non-public URLs are not fetchable";
  }
  return null;
}

async function privateUrlReason(raw: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "url must be a valid absolute URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "url must use http or https";
  }
  const host = stripTrailingDots(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""));
  if (!host) return "url host is required";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback URLs are not fetchable";
  const literalReason = privateIpReason(host);
  if (literalReason) return literalReason;
  if (net.isIP(host) !== 0) return null;
  return "url host must be a literal public IP address; hostname fetches are disabled to prevent DNS rebinding";
}

async function fetchPublicUrl(raw: string, redirects = 0): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  if (redirects > 5) return { ok: false, error: "too many URL redirects" };
  const unsafe = await privateUrlReason(raw);
  if (unsafe) return { ok: false, error: unsafe };
  const response = await fetch(raw, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) return { ok: true, response };
    try {
      return fetchPublicUrl(new URL(location, raw).toString(), redirects + 1);
    } catch {
      return { ok: false, error: "redirect location must be a valid URL" };
    }
  }
  return { ok: true, response };
}

/** Delete date-bucket directories under UPLOADS_DIR older than maxAgeDays. Returns count removed. */
export function cleanupOldUploads(maxAgeDays = 30): number {
  if (!fs.existsSync(UPLOADS_DIR)) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Bucket dirs are YYYY-MM-DD; parse and compare. Skip anything unexpected.
    const ts = Date.parse(`${entry.name}T00:00:00.000Z`);
    if (Number.isNaN(ts) || ts >= cutoff) continue;
    try {
      fs.rmSync(path.join(UPLOADS_DIR, entry.name), { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn(`Failed to remove old upload bucket ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (removed > 0) logger.info(`Cleaned up ${removed} upload bucket(s) older than ${maxAgeDays} days`);
  return removed;
}

// MIME type lookup by extension
const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "application/javascript",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

export function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// ── Managed file read (web UI + MCP belt) ────────────────────────
// GRS-020e: this route used to resolve arbitrary filesystem paths. It is now
// confined to managed file roots only (`files/` and `uploads/`) with the same
// layered containment pattern as knowledge/read: shape gate, raw control-byte
// rejection, then realpath containment as the authority.

/** Max bytes we'll read into memory for inline display. Larger files → tooLarge flag. */
export const MAX_READ_SIZE = 5 * 1024 * 1024; // 5 MB

/** MIME types treated as binary regardless of NUL-byte scan. */
function isBinaryMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime.startsWith("font/") ||
    mime === "application/pdf" ||
    mime === "application/zip" ||
    mime === "application/gzip" ||
    mime === "application/x-tar" ||
    mime === "application/octet-stream" ||
    mime === "application/msword" ||
    mime.startsWith("application/vnd.")
  );
}

const FILE_READ_ROOT_LABELS = ["files", "uploads"] as const;
type FileReadRootLabel = (typeof FILE_READ_ROOT_LABELS)[number];

function rawManagedPathError(requestedPath: string): { status: 400 | 403; error: string } | null {
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.trim().length === 0) {
    return { status: 400, error: "path query parameter is required" };
  }
  if (requestedPath !== requestedPath.trim()) {
    return { status: 400, error: "path must not have leading or trailing whitespace" };
  }
  if (requestedPath.length > 1024) {
    return { status: 400, error: "path is too long (max 1024 chars)" };
  }
  // Reject, never strip, control bytes on the raw decoded path. A %00-tampered
  // request must not become a repaired valid path.
  if (hasControlBytes(requestedPath)) {
    return { status: 400, error: "path contains control bytes — pass a managed files/ or uploads/ relative path exactly" };
  }
  if (requestedPath.includes("\\")) {
    return { status: 400, error: "path must use forward slashes; backslash separators are not accepted" };
  }
  if (path.isAbsolute(requestedPath) || requestedPath.startsWith("~")) {
    return { status: 403, error: "absolute and home-relative paths are not readable; use a managed files/ or uploads/ relative path" };
  }
  const parts = requestedPath.split("/");
  const label = parts[0] as FileReadRootLabel;
  if (!(FILE_READ_ROOT_LABELS as readonly string[]).includes(label)) {
    return { status: 403, error: 'path must start with "files/" or "uploads/" — arbitrary filesystem reads are not allowed' };
  }
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..")) {
    return { status: 400, error: 'path must be a normalized relative path under "files/" or "uploads/" with no "." or ".." segments' };
  }
  return null;
}

function managedReadRoot(label: FileReadRootLabel): string {
  return label === "files" ? FILES_DIR : UPLOADS_DIR;
}

function isInsideRealPath(realFile: string, realRoot: string): boolean {
  return realFile === realRoot || realFile.startsWith(realRoot + path.sep);
}

function rootRealpath(label: FileReadRootLabel): string | null {
  try {
    const real = fs.realpathSync.native(managedReadRoot(label));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function rawQueryParamValue(reqUrl: string | undefined, name: string): string | null {
  const query = (reqUrl || "").split("?", 2)[1];
  if (!query) return null;
  for (const part of query.split("&")) {
    const idx = part.indexOf("=");
    const rawKey = idx === -1 ? part : part.slice(0, idx);
    const rawValue = idx === -1 ? "" : part.slice(idx + 1);
    try {
      if (decodeURIComponent(rawKey.replace(/\+/g, " ")) === name) return rawValue;
    } catch {
      if (rawKey === name) return rawValue;
    }
  }
  return null;
}

function hasEncodedPathSeparator(rawValue: string | null): boolean {
  return rawValue !== null && /%(?:2f|5c)/i.test(rawValue);
}

/**
 * Build the candidate absolute path for a managed file read. Only relative
 * paths under `files/` or `uploads/` produce a candidate; absolute, home,
 * project, cwd, traversal, backslash, and other-root paths produce none.
 */
export function readPathCandidates(requestedPath: string): string[] {
  const p = String(requestedPath ?? "");
  if (rawManagedPathError(p)) return [];
  return [path.resolve(JINN_HOME, p)];
}

/**
 * Resolve a requested path to the first candidate that exists as a regular file.
 * Returns { resolvedPath: null, candidates } when none exist.
 */
export function resolveReadPath(requestedPath: string): { resolvedPath: string | null; candidates: string[]; error?: string; status?: 400 | 403 } {
  const shapeError = rawManagedPathError(String(requestedPath ?? ""));
  if (shapeError) return { resolvedPath: null, candidates: [], ...shapeError };
  const candidates = readPathCandidates(requestedPath);
  for (const candidate of candidates) {
    const label = String(requestedPath).split("/")[0] as FileReadRootLabel;
    const realRoot = rootRealpath(label);
    if (!realRoot) return { resolvedPath: null, candidates };
    try {
      if (!fs.existsSync(candidate)) continue;
      const realFile = fs.realpathSync.native(candidate);
      if (!isInsideRealPath(realFile, realRoot)) {
        return {
          resolvedPath: null,
          candidates,
          status: 403,
          error: `${requestedPath} resolves outside the ${label}/ root and is not readable`,
        };
      }
      if (fs.statSync(realFile).isFile()) return { resolvedPath: realFile, candidates };
    } catch {
      // unreadable candidate — skip
    }
  }
  return { resolvedPath: null, candidates };
}

export interface FileReadAssessment { allowed: boolean; reason?: string }

function pathSegments(absPath: string): string[] {
  return path.resolve(absPath).split(path.sep).filter(Boolean).map((s) => s.toLowerCase());
}

function realpathOrResolved(absPath: string): string {
  const resolved = path.resolve(absPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isInsidePath(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function assessSingleResolvedPath(resolved: string): FileReadAssessment {
  const base = path.basename(resolved).toLowerCase();
  const segments = pathSegments(resolved);
  const home = realpathOrResolved(os.homedir());
  const jinnHome = realpathOrResolved(JINN_HOME);
  if (base.startsWith(".env")) return { allowed: false, reason: "Refusing to read environment secret files" };
  // The leading dot is optional: Claude Code's OAuth token lives in `.credentials.json`,
  // which an anchored `credentials(\.json)?` never matched.
  if (/^\.?(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key|auth\.json|credentials(?:\.json)?|token(?:\.json|\.txt)?)$/i.test(base)) {
    return { allowed: false, reason: "Refusing to read private keys or token files" };
  }
  if (isInsidePath(resolved, path.join(home, ".ssh"))) return { allowed: false, reason: "Refusing to read SSH secrets" };
  if (isInsidePath(resolved, path.join(jinnHome, "secrets"))) return { allowed: false, reason: "Refusing to read Jinn secrets" };
  // A literal ".claude" segment covers project-local dirs; the resolved config dir
  // covers the real one, which CLAUDE_CONFIG_DIR can move anywhere (the container
  // does exactly that).
  const claudeConfigDir = realpathOrResolved(resolveClaudeConfigDir());
  if ((segments.includes(".claude") || isInsidePath(resolved, claudeConfigDir)) && base.startsWith("auth")) {
    return { allowed: false, reason: "Refusing to read Claude auth files" };
  }
  if (segments.includes(".codex") && base === "auth.json") return { allowed: false, reason: "Refusing to read Codex auth files" };
  return { allowed: true };
}

export function assessFileRead(absPath: string, _opts: { authenticated?: boolean } = {}): FileReadAssessment {
  const requested = path.resolve(expandPath(absPath));
  const candidates = [requested];
  const real = realpathOrResolved(requested);
  if (real !== requested) candidates.push(real);
  for (const candidate of candidates) {
    const assessment = assessSingleResolvedPath(candidate);
    if (!assessment.allowed) return assessment;
  }
  return { allowed: true };
}

export interface FileClassification {
  mime: string;
  size: number;
  /** true when the file is over MAX_READ_SIZE — content is NOT read. */
  tooLarge: boolean;
  /** true when detected as binary (by MIME or NUL byte) — content is NOT returned. */
  binary: boolean;
  /** utf-8 text content; only present for non-binary, non-too-large files. */
  content?: string;
}

interface ManagedFileRead {
  resolvedPath: string;
  classification: FileClassification;
}

interface ManagedFileReadError {
  status: 400 | 403 | 404 | 500;
  error: string;
}

function sameInode(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function classifyOpenedFile(fd: number, filename: string, stat = fs.fstatSync(fd)): FileClassification {
  const size = stat.size;
  const mime = mimeFromFilename(filename);

  if (!stat.isFile()) {
    throw new FileRequestError("Not a file");
  }
  if (size > MAX_READ_SIZE) {
    return { mime, size, tooLarge: true, binary: false };
  }
  if (isBinaryMime(mime)) {
    return { mime, size, tooLarge: false, binary: true };
  }

  const buffer = fs.readFileSync(fd);
  const scanLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < scanLen; i++) {
    if (buffer[i] === 0) {
      return { mime, size, tooLarge: false, binary: true };
    }
  }

  return { mime, size, tooLarge: false, binary: false, content: redactText(buffer.toString("utf-8")) };
}

/**
 * Open, authorize, and read a managed path through ONE file descriptor.
 *
 * Security invariant: authorization and byte-read are tied to the same opened
 * inode. The leaf is opened with O_NOFOLLOW, the opened fd's real path is checked
 * against the selected managed root, bytes are read from that fd, and a final
 * path-stability check refuses a swap that happened during the read. The route
 * never re-opens the authorized path string for content.
 */
export function readManagedFile(requestedPath: string): ManagedFileRead | ManagedFileReadError {
  const shapeError = rawManagedPathError(String(requestedPath ?? ""));
  if (shapeError) return shapeError;
  const label = String(requestedPath).split("/")[0] as FileReadRootLabel;
  const realRoot = rootRealpath(label);
  if (!realRoot) return { status: 404, error: "Not found" };
  const candidate = path.resolve(JINN_HOME, requestedPath);
  let fd: number | null = null;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile()) return { status: 400, error: "Not a file" };
    const openedRealPath = fs.realpathSync.native(candidate);
    if (!isInsideRealPath(openedRealPath, realRoot)) {
      return { status: 403, error: `${requestedPath} resolves outside the ${label}/ root and is not readable` };
    }
    const currentStat = fs.statSync(openedRealPath);
    if (!sameInode(openedStat, currentStat)) {
      return { status: 403, error: `${requestedPath} changed during open and was refused` };
    }
    const assessment = assessFileRead(openedRealPath, { authenticated: true });
    if (!assessment.allowed) {
      return { status: 403, error: assessment.reason || "File read blocked by security policy" };
    }
    const classification = classifyOpenedFile(fd, requestedPath, openedStat);
    try {
      const finalRealPath = fs.realpathSync.native(candidate);
      const finalStat = fs.statSync(finalRealPath);
      if (finalRealPath !== openedRealPath || !sameInode(openedStat, finalStat)) {
        return { status: 403, error: `${requestedPath} changed during read and was refused` };
      }
    } catch {
      return { status: 403, error: `${requestedPath} changed during read and was refused` };
    }
    return { resolvedPath: openedRealPath, classification };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof FileRequestError) return { status: 400, error: err.message };
    if (code === "ENOENT" || code === "ENOTDIR") return { status: 404, error: "Not found" };
    if (code === "ELOOP") return { status: 403, error: `${requestedPath} is a symlink leaf and is not readable` };
    return { status: 500, error: err instanceof Error ? err.message : "Read failed" };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Classify an existing file: size cap → binary detection → text read.
 * Caller must guarantee absPath is a regular file. Pure-ish (touches disk
 * read-only); unit-tested against temp files.
 */
export function classifyFile(absPath: string): FileClassification {
  const stat = fs.statSync(absPath);
  const size = stat.size;
  const mime = mimeFromFilename(absPath);

  if (size > MAX_READ_SIZE) {
    return { mime, size, tooLarge: true, binary: false };
  }

  // MIME says binary → don't even read it as text.
  if (isBinaryMime(mime)) {
    return { mime, size, tooLarge: false, binary: true };
  }

  const buffer = fs.readFileSync(absPath);
  // Scan first 8 KB for a NUL byte → binary.
  const scanLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < scanLen; i++) {
    if (buffer[i] === 0) {
      return { mime, size, tooLarge: false, binary: true };
    }
  }

  return { mime, size, tooLarge: false, binary: false, content: redactText(buffer.toString("utf-8")) };
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

interface UploadResult {
  id: string;
  filename: string;
  buffer: Buffer;
  customPath: string | null;
  open: boolean;
  /** When set, the file is stored date-bucketed under UPLOADS_DIR/<date>/<sessionId>/ instead of FILES_DIR. */
  sessionId?: string | null;
}

/** Save buffer to managed storage and optionally to a custom path. */
async function saveFile(result: UploadResult, context: ApiContext): Promise<FileMeta> {
  // Always sanitize the filename — it ends up as a path segment on disk and in headers.
  const safeName = sanitizeUploadFilename(result.filename);
  const customPath = resolveCustomUploadPath(result.customPath);
  if (result.customPath && (!allowCustomUploadPaths(context) || !customPath)) {
    throw new FileRequestError("custom upload paths are disabled or outside managed storage");
  }

  // Session-scoped uploads land in date-bucketed dirs; everything else stays in FILES_DIR/<id>/.
  const sessionScoped = !!result.sessionId;
  const storageDir = sessionScoped
    ? uploadDir(result.sessionId!)
    : path.join(FILES_DIR, result.id);
  await fs.promises.mkdir(storageDir, { recursive: true });
  const storagePath = path.join(storageDir, safeName);
  await fs.promises.writeFile(storagePath, result.buffer);

  const mimetype = mimeFromFilename(safeName);
  const meta = insertFile({
    id: result.id,
    filename: safeName,
    size: result.buffer.length,
    mimetype,
    // For session uploads, record the absolute on-disk path so download + path-injection can find it.
    path: sessionScoped ? storagePath : customPath,
  });

  // Write to custom path if provided
  if (customPath) {
    await fs.promises.mkdir(path.dirname(customPath), { recursive: true });
    await fs.promises.writeFile(customPath, result.buffer);
  }

  // Open file if requested
  if (result.open && allowUploadedFileOpen(context)) {
    const targetPath = customPath || storagePath;
    const { spawn } = await import("node:child_process");
    spawn("open", [targetPath], { stdio: "ignore", detached: true }).unref();
  }

  logger.info(`File uploaded: ${result.filename} (${result.id}, ${result.buffer.length} bytes)`);

  return meta;
}

export type LocalFileIngestion =
  | { ok: true; buffer: Buffer; realPath: string }
  | { ok: false; status: 400 | 403 | 404 | 413; error: string };

/**
 * Read a caller-named local file for ingestion (e.g. JSON-path attachment
 * uploads) under the standing file-read policy. Symlink-swap-proof: the source
 * is canonicalized and opened ONCE (O_NOFOLLOW on the canonical path), the
 * assessment runs against that opened real path, the size cap uses fstat on
 * the SAME descriptor, and the bytes are read from that descriptor — a path
 * swapped between checks is detected by inode comparison and refused.
 */
export function readLocalFileForIngestion(requestedPath: string, maxBytes: number): LocalFileIngestion {
  const requested = path.resolve(expandPath(requestedPath));
  let fd: number | null = null;
  try {
    const realPath = fs.realpathSync.native(requested);
    fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile()) return { ok: false, status: 400, error: `not a file: ${requestedPath}` };
    // The opened descriptor must still be what the canonical path names — a
    // swap between realpath and open surfaces as an inode mismatch.
    const currentStat = fs.statSync(realPath);
    if (!sameInode(openedStat, currentStat)) {
      return { ok: false, status: 403, error: `${requestedPath} changed during open and was refused` };
    }
    const assessment = assessFileRead(realPath, { authenticated: true });
    if (!assessment.allowed) {
      return { ok: false, status: 403, error: assessment.reason || "File read blocked by security policy" };
    }
    if (openedStat.size > maxBytes) {
      return { ok: false, status: 413, error: `attachment exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB per-file limit` };
    }
    const buffer = Buffer.alloc(openedStat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== buffer.length) {
      return { ok: false, status: 403, error: `${requestedPath} changed during read and was refused` };
    }
    return { ok: true, buffer, realPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, status: 404, error: `file not found: ${requestedPath}` };
    if (code === "ELOOP") return { ok: false, status: 403, error: `${requestedPath} changed during open and was refused` };
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "read failed" };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export interface MultipartFileUpload {
  filename: string;
  buffer: Buffer;
  fields: Record<string, string>;
  /** True when the file hit the size limit and was cut off — reject the upload. */
  truncated: boolean;
}

/** A refused multipart request — carries the HTTP status the route should emit. */
export class MultipartUploadError extends Error {
  readonly status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(message);
    this.name = "MultipartUploadError";
    this.status = status;
  }
}

/** Small metadata fields (e.g. commentId) only — anything larger is refused. */
const MULTIPART_FIELD_MAX_BYTES = 1024;
const MULTIPART_MAX_FIELDS = 4;
const MULTIPART_MAX_PARTS = 6;
/** Boundary/header overhead allowance on top of the single permitted file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Parse a single-file multipart request into memory — the shared upload
 * machinery consumers outside this module (e.g. work-item attachments) reuse
 * instead of wiring Busboy themselves. Hardened (Todos v2 slice-5 review F3):
 * exactly ONE file part, and it must be named "file"; strict Busboy
 * files/fields/parts/fieldSize limits; every limit event and unexpected part
 * is a refusal; and an aggregate request-byte ceiling
 * (maxFileSize + overhead) is enforced up front from Content-Length AND while
 * streaming, so many individually-valid parts cannot accumulate memory. On
 * refusal all buffered chunks are dropped immediately.
 */
export function readMultipartFile(req: HttpRequest, maxFileSize: number): Promise<MultipartFileUpload> {
  return new Promise((resolve, reject) => {
    const aggregateCeiling = maxFileSize + MULTIPART_OVERHEAD_BYTES;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > aggregateCeiling) {
      reject(new MultipartUploadError(413, `multipart request exceeds the ${Math.floor(maxFileSize / 1024 / 1024)} MB upload ceiling`));
      return;
    }
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fileSize: maxFileSize,
        files: 1,
        fields: MULTIPART_MAX_FIELDS,
        parts: MULTIPART_MAX_PARTS,
        fieldSize: MULTIPART_FIELD_MAX_BYTES,
      },
    });
    let filename = "";
    let buffer: Buffer | null = null;
    let chunks: Buffer[] = [];
    const fields: Record<string, string> = {};
    let truncated = false;
    let sawFile = false;
    let settled = false;
    let aggregate = 0;

    const finish = (value: MultipartFileUpload | MultipartUploadError | Error): void => {
      if (settled) return;
      settled = true;
      // Drop everything buffered so a refusal retains nothing.
      chunks = [];
      buffer = null;
      if (value instanceof Error) {
        try { req.unpipe(busboy); } catch { /* already detached */ }
        try { (req as unknown as { resume?: () => void }).resume?.(); } catch { /* best effort */ }
        reject(value);
      } else {
        resolve(value);
      }
    };

    // Streaming belt for chunked/omitted Content-Length: count every request
    // byte and refuse past the same ceiling.
    req.on("data", (chunk: Buffer) => {
      aggregate += chunk.length;
      if (aggregate > aggregateCeiling) {
        finish(new MultipartUploadError(413, `multipart request exceeds the ${Math.floor(maxFileSize / 1024 / 1024)} MB upload ceiling`));
      }
    });

    busboy.on("file", (fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
      if (settled) { (file as unknown as { resume: () => void }).resume(); return; }
      if (fieldname !== "file") {
        (file as unknown as { resume: () => void }).resume();
        finish(new MultipartUploadError(400, `unexpected file field "${fieldname}" — send exactly one file field named "file"`));
        return;
      }
      if (sawFile) {
        (file as unknown as { resume: () => void }).resume();
        finish(new MultipartUploadError(400, 'multiple file parts — send exactly one file field named "file"'));
        return;
      }
      sawFile = true;
      filename = info.filename;
      file.on("data", (chunk: Buffer) => { if (!settled) chunks.push(chunk); });
      (file as NodeJS.EventEmitter).on("limit", () => { truncated = true; });
      file.on("end", () => { if (!settled) buffer = Buffer.concat(chunks); });
    });
    busboy.on("field", (name: string, value: string, info?: { valueTruncated?: boolean; nameTruncated?: boolean }) => {
      if (settled) return;
      if (info?.valueTruncated || info?.nameTruncated) {
        finish(new MultipartUploadError(400, `multipart field "${name}" exceeds the ${MULTIPART_FIELD_MAX_BYTES}-byte field limit`));
        return;
      }
      fields[name] = value;
    });
    // Busboy stops COUNTING at the limits; treat hitting any of them as a refusal.
    busboy.on("filesLimit", () => finish(new MultipartUploadError(400, 'multiple file parts — send exactly one file field named "file"')));
    busboy.on("fieldsLimit", () => finish(new MultipartUploadError(400, `too many multipart fields (max ${MULTIPART_MAX_FIELDS})`)));
    busboy.on("partsLimit", () => finish(new MultipartUploadError(400, `too many multipart parts (max ${MULTIPART_MAX_PARTS})`)));
    busboy.on("finish", () => finish({ filename, buffer: buffer ?? Buffer.alloc(0), fields, truncated }));
    busboy.on("error", (err: Error) => finish(err));
    req.pipe(busboy);
  });
}

/** Handle POST /api/files — multipart upload */
async function handleMultipartUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  return new Promise((resolve) => {
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE } });
    let filename = "";
    let fileBuffer: Buffer | null = null;
    let customPath: string | null = null;
    let open = false;
    let sessionId: string | null = null;
    let fileTruncated = false;

    busboy.on("file", (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
      filename = info.filename;
      const chunks: Buffer[] = [];
      file.on("data", (chunk: Buffer) => chunks.push(chunk));
      (file as NodeJS.EventEmitter).on("limit", () => { fileTruncated = true; });
      file.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });

    busboy.on("field", (name: string, val: string) => {
      if (name === "path") customPath = val;
      if (name === "open") open = val === "true" || val === "1";
      if (name === "sessionId") sessionId = val;
    });

    busboy.on("finish", async () => {
      if (fileTruncated) {
        badRequest(res, `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`);
        resolve();
        return;
      }
      if (!fileBuffer || !filename) {
        badRequest(res, "No file provided");
        resolve();
        return;
      }
      try {
        const meta = await saveFile({
          id: crypto.randomUUID(),
          filename,
          buffer: fileBuffer,
          customPath,
          open,
          sessionId,
        }, context);
        json(res, meta, 201);
      } catch (err) {
        if (err instanceof FileRequestError) {
          badRequest(res, err.message);
          resolve();
          return;
        }
        serverError(res, err instanceof Error ? err.message : "Upload failed");
      }
      resolve();
    });

    busboy.on("error", (err: Error) => {
      serverError(res, err.message);
      resolve();
    });

    req.pipe(busboy);
  });
}

/** Handle POST /api/files — JSON body (base64 content or URL fetch) */
async function handleJsonUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return badRequest(res, "Invalid JSON body");
  }

  const filename = body.filename as string | undefined;
  const content = body.content as string | undefined;
  const url = body.url as string | undefined;
  const customPath = (body.path as string) || null;
  const open = !!body.open;
  const sessionId = (body.sessionId as string) || null;

  if (!filename) return badRequest(res, "filename is required");
  if (content && url) return badRequest(res, "content and url are mutually exclusive");
  if (!content && !url) return badRequest(res, "content or url is required");

  let buffer: Buffer;

  if (content) {
    // Base64 decode
    try {
      buffer = Buffer.from(content, "base64");
    } catch {
      return badRequest(res, "Invalid base64 content");
    }
  } else {
    // URL fetch
    try {
      const fetched = await fetchPublicUrl(url!);
      if (!fetched.ok) return badRequest(res, fetched.error);
      const { response } = fetched;
      if (!response.ok) {
        return serverError(res, `Failed to fetch URL: ${response.status} ${response.statusText}`);
      }
      const arrayBuf = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
    } catch (err) {
      return serverError(res, `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const meta = await saveFile({
      id: crypto.randomUUID(),
      filename,
      buffer,
      customPath,
      open,
      sessionId,
    }, context);
    json(res, meta, 201);
  } catch (err) {
    if (err instanceof FileRequestError) {
      return badRequest(res, err.message);
    }
    serverError(res, err instanceof Error ? err.message : "Upload failed");
  }
}

// ── Transfer types ──────────────────────────────────────────────

interface TransferSpec {
  file: string;       // managed file ID from /api/files
  remotePath?: string; // destination path on remote (defaults to same relative path)
}

interface TransferRequest {
  destination: string; // remote gateway URL or remote name from config
  files: TransferSpec[];
}

interface TransferResult {
  file: string;
  remotePath: string | null;
  status: "ok" | "error";
  remoteId?: string;
  error?: string;
}

const MAX_TRANSFER_SIZE = 50 * 1024 * 1024; // 50 MB
type RemoteConfig = { remotes?: Record<string, { url: string; label?: string; token?: string }> };

/** Resolve a file spec to { buffer, filename, relativePath }. */
function resolveFileSpec(spec: TransferSpec): { buffer: Buffer; filename: string; relativePath: string | null } {
  const meta = getFile(spec.file);
  if (meta) {
    const candidates = [path.join(FILES_DIR, meta.id, meta.filename), meta.path].filter(
      (p): p is string => !!p,
    );
    const filePath = candidates.find((p) => isServablePath(p) && fs.existsSync(p) && fs.statSync(p).isFile());
    if (!filePath) {
      throw new Error(`Managed file ${spec.file} exists in DB but not on disk`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_TRANSFER_SIZE) {
      throw new Error(`File ${spec.file} is ${(stat.size / 1024 / 1024).toFixed(1)} MB — exceeds 50 MB transfer limit`);
    }
    const assessment = assessFileRead(filePath, { authenticated: true });
    if (!assessment.allowed) throw new Error(assessment.reason || "File read blocked by security policy");
    return {
      buffer: fs.readFileSync(filePath),
      filename: meta.filename,
      relativePath: meta.path || null,
    };
  }

  throw new Error(`Managed file not found: ${spec.file}`);
}

/** Resolve destination URL — accept raw URL or remote name from config. Whitelist is enforced after resolution. */
function resolveDestination(destination: string, config: RemoteConfig): string {
  // If it looks like a URL, use directly
  if (destination.startsWith("http://") || destination.startsWith("https://")) {
    return destination.replace(/\/+$/, "");
  }
  // Look up in config remotes
  const remote = config.remotes?.[destination];
  if (!remote) {
    throw new Error(`Unknown remote "${destination}". Add it to config.yaml remotes or use a full URL.`);
  }
  return remote.url.replace(/\/+$/, "");
}

/** Check if a destination URL is whitelisted in config remotes. */
function isAllowedRemote(destUrl: string, config: RemoteConfig): boolean {
  if (!config.remotes) return false;
  const normalized = destUrl.replace(/\/+$/, "");
  return Object.values(config.remotes).some(r => r.url.replace(/\/+$/, "") === normalized);
}

export function buildRemoteUploadBody(filename: string, buffer: Buffer, remotePath: string | null | undefined): Record<string, string> {
  return {
    filename,
    content: buffer.toString("base64"),
    ...(remotePath ? { path: remotePath } : {}),
  };
}

function remoteTokenFor(destUrl: string, config: RemoteConfig): string | undefined {
  const normalized = destUrl.replace(/\/+$/, "");
  return Object.values(config.remotes ?? {}).find((remote) => remote.url.replace(/\/+$/, "") === normalized)?.token;
}

export function remoteUploadHeaders(destUrl: string, config: RemoteConfig): Record<string, string> {
  const token = remoteTokenFor(destUrl, config);
  return {
    "Content-Type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** POST /api/files/transfer — send files to a remote gateway. */
async function handleTransfer(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return badRequest(res, "Invalid JSON body");
  }

  const destination = body.destination as string | undefined;
  if (!destination) return badRequest(res, "destination is required");

  // Normalize: accept single file spec or array
  let fileSpecs: TransferSpec[];
  if (body.files && Array.isArray(body.files)) {
    fileSpecs = body.files as TransferSpec[];
  } else if (body.file) {
    fileSpecs = [{
      file: body.file as string,
      remotePath: body.remotePath as string | undefined,
    }];
  } else {
    return badRequest(res, "file or files is required");
  }

  if (fileSpecs.length === 0) return badRequest(res, "files array is empty");

  // Resolve and validate destination
  const config = context.getConfig();
  let destUrl: string;
  try {
    destUrl = resolveDestination(destination, config);
  } catch (err) {
    return badRequest(res, err instanceof Error ? err.message : String(err));
  }

  if (!isAllowedRemote(destUrl, config)) {
    return json(res, { error: `Remote "${destUrl}" is not in config.yaml remotes whitelist` }, 403);
  }

  // Transfer each file
  const results: TransferResult[] = [];
  for (const spec of fileSpecs) {
    try {
      const { buffer, filename } = resolveFileSpec(spec);
      const targetPath = spec.remotePath || null;
      const uploadBody = buildRemoteUploadBody(filename, buffer, targetPath);

      const response = await fetch(`${destUrl}/api/files`, {
        method: "POST",
        headers: remoteUploadHeaders(destUrl, config),
        body: JSON.stringify(uploadBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        results.push({ file: spec.file, remotePath: targetPath, status: "error", error: `HTTP ${response.status}: ${errText}` });
      } else {
        const remoteMeta = await response.json() as { id: string };
        results.push({ file: spec.file, remotePath: targetPath, status: "ok", remoteId: remoteMeta.id });
      }
    } catch (err) {
      results.push({ file: spec.file, remotePath: spec.remotePath || null, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const ok = results.filter(r => r.status === "ok").length;
  const failed = results.filter(r => r.status === "error").length;
  logger.info(`File transfer to ${destUrl}: ${ok} ok, ${failed} failed`);

  json(res, { destination: destUrl, results, summary: { ok, failed, total: results.length } });
}

// ── Session attachments (outbound: session → web UI) ─────────────

function mediaTypeFromMime(mime: string | null): MessageMedia["type"] {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/")) return "audio";
  return "file";
}

function buildMessageMedia(meta: FileMeta): MessageMedia {
  return {
    type: mediaTypeFromMime(meta.mimetype),
    url: `/api/files/${meta.id}`,
    name: meta.filename,
    mimeType: meta.mimetype ?? undefined,
    size: meta.size,
  };
}

/** Resolve uploaded file IDs to media descriptors for persisting on a (user) message. */
export function fileIdsToMedia(fileIds: unknown): MessageMedia[] {
  if (!Array.isArray(fileIds)) return [];
  const media: MessageMedia[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (meta) media.push(buildMessageMedia(meta));
  }
  return media;
}

/**
 * Re-home first-message attachments: files uploaded before a session existed land
 * in FILES_DIR/<id>/. Once the session is created, move them into the date-bucketed
 * uploads dir and record the new path so they're co-located with the session.
 */
export function rehomeAttachmentsToSession(fileIds: unknown, sessionId: string): void {
  if (!Array.isArray(fileIds)) return;
  const destDir = uploadDir(sessionId);
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (!meta) continue;
    const current = path.join(FILES_DIR, meta.id, meta.filename);
    if (!fs.existsSync(current)) continue; // already session-scoped or missing
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, sanitizeUploadFilename(meta.filename));
    try {
      fs.renameSync(current, dest);
    } catch (err) {
      // Cross-device fallback: copy then remove.
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        fs.copyFileSync(current, dest);
        fs.rmSync(current, { force: true });
      } else {
        logger.warn(`Failed to re-home attachment ${id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    // Remove the now-empty FILES_DIR/<id> dir (best-effort).
    try { fs.rmdirSync(path.join(FILES_DIR, meta.id)); } catch { /* not empty / gone */ }
    setFilePath(meta.id, dest);
    logger.info(`Re-homed attachment ${meta.filename} (${id}) into session ${sessionId} uploads`);
  }
}

/** Persist a session-scoped file, attach it as an assistant message, and push it to the UI. */
async function finalizeAttachment(
  res: ServerResponse,
  sessionId: string,
  filename: string,
  buffer: Buffer,
  caption: string,
  context: ApiContext,
): Promise<void> {
  const meta = await saveFile({
    id: crypto.randomUUID(),
    filename,
    buffer,
    customPath: null,
    open: false,
    sessionId,
  }, context);
  const media = buildMessageMedia(meta);
  // Insert FIRST so the row is committed before we emit — the WS payload carries the
  // canonical message id so the web client can append optimistically AND dedupe/merge
  // it against the next history fetch (no disappear, no double-render).
  const messageId = insertMessage(sessionId, "assistant", caption, [media]);
  const timestamp = Date.now();
  context.emit("session:attachment", { sessionId, id: messageId, content: caption, media: [media], timestamp });
  logger.info(`Attachment pushed to session ${sessionId}: ${meta.filename} (${meta.id})`);
  json(res, { ...meta, media, message: { id: messageId, role: "assistant", content: caption, media: [media], timestamp } }, 201);
}

/** Handle POST /api/sessions/:id/attachments — multipart upload from the running agent. */
async function handleAttachmentMultipart(
  req: HttpRequest,
  res: ServerResponse,
  sessionId: string,
  context: ApiContext,
): Promise<void> {
  return new Promise((resolve) => {
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE } });
    let filename = "";
    let fileBuffer: Buffer | null = null;
    let caption = "";
    let fileTruncated = false;

    busboy.on("file", (_f: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
      filename = info.filename;
      const chunks: Buffer[] = [];
      file.on("data", (c: Buffer) => chunks.push(c));
      (file as NodeJS.EventEmitter).on("limit", () => { fileTruncated = true; });
      file.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });
    busboy.on("field", (name: string, val: string) => {
      if (name === "text" || name === "caption") caption = val;
    });
    busboy.on("finish", async () => {
      if (fileTruncated) { badRequest(res, `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`); resolve(); return; }
      if (!fileBuffer || !filename) { badRequest(res, "No file provided"); resolve(); return; }
      try {
        await finalizeAttachment(res, sessionId, filename, fileBuffer, caption, context);
      } catch (err) {
        serverError(res, err instanceof Error ? err.message : "Attachment failed");
      }
      resolve();
    });
    busboy.on("error", (err: Error) => { serverError(res, err.message); resolve(); });
    req.pipe(busboy);
  });
}

/** Handle POST /api/sessions/:id/attachments — JSON body ({path|content|url}). */
async function handleAttachmentJson(
  req: HttpRequest,
  res: ServerResponse,
  sessionId: string,
  context: ApiContext,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return badRequest(res, "Invalid JSON body");
  }

  const localPath = body.path as string | undefined;
  const content = body.content as string | undefined;
  const url = body.url as string | undefined;
  const caption = typeof body.text === "string" ? body.text : (typeof body.caption === "string" ? body.caption : "");
  let filename = body.filename as string | undefined;

  const provided = [localPath, content, url].filter(Boolean).length;
  if (provided === 0) return badRequest(res, "one of path, content (base64), or url is required");
  if (provided > 1) return badRequest(res, "path, content, and url are mutually exclusive");

  const MAX = 50 * 1024 * 1024;
  let buffer: Buffer;

  if (localPath) {
    if (!requireOperatorFileAuthority(req, res, "path attachment", context)) return;
    const expanded = expandPath(localPath);
    if (!fs.existsSync(expanded) || !fs.statSync(expanded).isFile()) {
      return badRequest(res, `File not found: ${localPath}`);
    }
    const stat = fs.statSync(expanded);
    if (stat.size > MAX) return badRequest(res, "File exceeds 50 MB limit");
    const assessment = assessFileRead(expanded, { authenticated: true });
    if (!assessment.allowed) return json(res, { error: assessment.reason || "File read blocked by security policy" }, 403);
    buffer = fs.readFileSync(expanded);
    if (!filename) filename = path.basename(expanded);
  } else if (content) {
    buffer = Buffer.from(content, "base64");
    if (buffer.length > MAX) return badRequest(res, "File exceeds 50 MB limit");
    if (!filename) return badRequest(res, "filename is required when sending base64 content");
  } else {
    try {
      const fetched = await fetchPublicUrl(url!);
      if (!fetched.ok) return badRequest(res, fetched.error);
      const { response } = fetched;
      if (!response.ok) return serverError(res, `Failed to fetch URL: ${response.status} ${response.statusText}`);
      buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX) return badRequest(res, "File exceeds 50 MB limit");
      if (!filename) filename = path.basename(new URL(url!).pathname) || "download";
    } catch (err) {
      return serverError(res, `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    await finalizeAttachment(res, sessionId, filename!, buffer, caption, context);
  } catch (err) {
    serverError(res, err instanceof Error ? err.message : "Attachment failed");
  }
}

/** Entry point for POST /api/sessions/:id/attachments (called from api.ts after session validation). */
export async function handleSessionAttachment(
  req: HttpRequest,
  res: ServerResponse,
  sessionId: string,
  context: ApiContext,
): Promise<void> {
  const contentType = (req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    await handleAttachmentMultipart(req, res, sessionId, context);
  } else {
    await handleAttachmentJson(req, res, sessionId, context);
  }
}

// ── HTTP caching for immutable file content ──────────────────────
// Files are stored by id and never mutated, so their bytes are content-immutable.
// We can cache aggressively and revalidate cheaply with ETag / Last-Modified.

/** Strong ETag derived from the immutable id + byte size. */
export function fileEtag(id: string, size: number): string {
  return `"${id}-${size}"`;
}

/**
 * Decide whether a conditional GET can be answered with 304 Not Modified.
 * If-None-Match wins over If-Modified-Since (per RFC 7232). ETag comparison
 * tolerates weak prefixes and comma-separated lists; "*" always matches.
 */
export function isFileNotModified(
  headers: HttpRequest["headers"],
  etag: string,
  lastModifiedMs: number,
): boolean {
  const inm = headers["if-none-match"];
  if (inm) {
    const norm = (t: string) => t.trim().replace(/^W\//, "");
    return inm === "*" || inm.split(",").some((t) => norm(t) === norm(etag));
  }
  const ims = headers["if-modified-since"];
  if (ims) {
    const since = Date.parse(ims);
    // HTTP dates have 1s precision — floor mtime to seconds before comparing.
    if (!Number.isNaN(since)) return Math.floor(lastModifiedMs / 1000) * 1000 <= since;
  }
  return false;
}

/** Route handler for all /api/files endpoints. Returns true if handled. */
export async function handleFilesRequest(
  req: HttpRequest,
  res: ServerResponse,
  pathname: string,
  method: string,
  context: ApiContext,
): Promise<boolean> {
  // GET /api/files/read?path=<path> — read one managed file under files/ or
  // uploads/. GRS-020e containment guard: raw path shape gate + control-byte
  // rejection + realpath containment. No arbitrary filesystem reads.
  if (method === "GET" && pathname === "/api/files/read") {
    if (rejectUnidentifiedToolCaller(req, res)) return true;
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const requested = reqUrl.searchParams.get("path");
    if (!requested) {
      badRequest(res, "path query parameter is required");
      return true;
    }
    if (hasEncodedPathSeparator(rawQueryParamValue(req.url, "path"))) {
      badRequest(res, "path contains encoded separators — pass a literal managed files/ or uploads/ relative path");
      return true;
    }
    try {
      const opened = readManagedFile(requested);
      if ("error" in opened) {
        if (opened.status === 404) notFound(res);
        else json(res, { error: opened.error }, opened.status);
        return true;
      }
      const c = opened.classification;
      json(res, {
        path: requested,
        resolvedPath: opened.resolvedPath,
        mime: c.mime,
        size: c.size,
        tooLarge: c.tooLarge,
        binary: c.binary,
        ...(c.content !== undefined ? { content: c.content } : {}),
      });
    } catch (err) {
      serverError(res, err instanceof Error ? err.message : "Read failed");
    }
    return true;
  }

  // POST /api/files/transfer — send files to remote gateway
  if (method === "POST" && pathname === "/api/files/transfer") {
    if (!requireOperatorFileAuthority(req, res, "file transfer", context)) return true;
    await handleTransfer(req, res, context);
    return true;
  }

  // POST /api/files — upload
  if (method === "POST" && pathname === "/api/files") {
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
      await handleMultipartUpload(req, res, context);
    } else {
      await handleJsonUpload(req, res, context);
    }
    return true;
  }

  // GET /api/files — list all
  if (method === "GET" && pathname === "/api/files") {
    if (rejectUnidentifiedToolCaller(req, res)) return true;
    json(res, listFiles());
    return true;
  }

  // GET /api/files/:id/meta — file metadata
  const metaMatch = pathname.match(/^\/api\/files\/([^/]+)\/meta$/);
  if (method === "GET" && metaMatch) {
    if (rejectUnidentifiedToolCaller(req, res)) return true;
    const meta = getFile(metaMatch[1]);
    if (!meta) { notFound(res); return true; }
    json(res, meta);
    return true;
  }

  // GET /api/files/:id — download file
  const dlMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (method === "GET" && dlMatch) {
    if (rejectUnidentifiedToolCaller(req, res)) return true;
    const meta = getFile(dlMatch[1]);
    if (!meta) { notFound(res); return true; }
    // Managed storage first, then the recorded path (e.g. session uploads under UPLOADS_DIR).
    // Only ever serve files that resolve inside FILES_DIR/UPLOADS_DIR — never an arbitrary path.
    const candidates = [path.join(FILES_DIR, meta.id, meta.filename), meta.path].filter(
      (p): p is string => !!p,
    );
    const filePath = candidates.find((p) => isServablePath(p) && fs.existsSync(p) && fs.statSync(p).isFile());
    if (!filePath) {
      notFound(res);
      return true;
    }
    const stat = fs.statSync(filePath);
    // Content-immutable: cache forever + revalidate cheaply with ETag/Last-Modified.
    const etag = fileEtag(meta.id, stat.size);
    const cacheHeaders = {
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
      "Last-Modified": stat.mtime.toUTCString(),
    };
    // Conditional GET → 304 with no body (validators only). Cheaper than re-streaming.
    if (isFileNotModified(req.headers, etag, stat.mtimeMs)) {
      res.writeHead(304, cacheHeaders);
      res.end();
      return true;
    }
    // Sanitize filename to prevent Content-Disposition header injection.
    // Strip anything that isn't alphanumeric, dash, underscore, period, or space,
    // then use the RFC 5987 filename* parameter with percent-encoding.
    const sanitizedFilename = meta.filename.replace(/[^\w.\- ]/g, "_");
    res.writeHead(200, {
      "Content-Type": meta.mimetype || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      "Content-Length": stat.size,
      ...cacheHeaders,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // DELETE /api/files/:id
  const delMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (method === "DELETE" && delMatch) {
    if (!requireOperatorFileAuthority(req, res, "file delete", context)) return true;
    const id = delMatch[1];
    const meta = getFile(id);
    if (!meta) { notFound(res); return true; }

    // Remove managed storage directory
    const fileDir = path.join(FILES_DIR, id);
    if (fs.existsSync(fileDir)) {
      fs.rmSync(fileDir, { recursive: true, force: true });
    }
    // Session-scoped uploads live under UPLOADS_DIR (recorded in meta.path) — remove that too.
    if (meta.path && isServablePath(meta.path) && fs.existsSync(meta.path)) {
      fs.rmSync(meta.path, { force: true });
    }

    deleteFile(id);
    logger.info(`File deleted: ${meta.filename} (${id})`);
    json(res, { status: "deleted" });
    return true;
  }

  return false;
}
