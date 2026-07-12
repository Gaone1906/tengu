import fs from "node:fs";
import path from "node:path";
import { assertBoundCaller, gatewayGet, gatewayRequest, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";

const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 50;
const MANAGED_PREFIXES = ["files/", "uploads/"] as const;
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_CAPTION_MAX_CHARS = 4_000;

interface FileMetaWire {
  id?: unknown;
  filename?: unknown;
  size?: unknown;
  mimetype?: unknown;
  path?: unknown;
  createdAt?: unknown;
}

function asText(body: unknown, max = 1200): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function clampLimit(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : LIST_LIMIT_DEFAULT;
  return Math.max(1, Math.min(n, LIST_LIMIT_MAX));
}

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join("/");
}

function pathWithin(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function managedRoots(): { home: string; filesDir: string; uploadsDir: string } {
  const home = process.env.JINN_HOME || path.join(process.env.HOME || process.cwd(), ".jinn");
  return {
    home,
    filesDir: path.join(home, "files"),
    uploadsDir: path.join(home, "uploads"),
  };
}

function managedPath(meta: FileMetaWire): string | undefined {
  const id = typeof meta.id === "string" && meta.id.trim() ? meta.id.trim() : undefined;
  const filename = typeof meta.filename === "string" && meta.filename.trim() ? meta.filename.trim() : undefined;
  const roots = managedRoots();
  if (typeof meta.path === "string" && meta.path.trim()) {
    const abs = path.resolve(meta.path);
    if (pathWithin(abs, roots.filesDir) || pathWithin(abs, roots.uploadsDir)) {
      const rel = normalizeRel(path.relative(roots.home, abs));
      if (MANAGED_PREFIXES.some((prefix) => rel.startsWith(prefix))) return rel;
    }
  }
  if (id && filename) return `files/${encodeURIComponent(id).replace(/%/g, "_")}/${filename}`;
  return undefined;
}

function shapeGateManagedPath(value: unknown): string {
  if (typeof value !== "string") throw new JinnMcpToolError("path is required and must be a managed relative path");
  if (value.length === 0) throw new JinnMcpToolError("path is required and must be a managed relative path");
  if (value !== value.trim()) throw new JinnMcpToolError("path must be a normalized managed relative path with no surrounding whitespace");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new JinnMcpToolError("path contains control bytes");
  if (value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new JinnMcpToolError("path must be relative to the managed files root");
  }
  if (value.includes("\\")) throw new JinnMcpToolError("path must use forward slash separators");
  if (!MANAGED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new JinnMcpToolError("path must be under managed files/ or uploads/");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new JinnMcpToolError("path must be normalized and cannot contain traversal");
  }
  return value;
}

function encodeManagedPath(rel: string): string {
  return rel.split("/").map(encodeURIComponent).join("/");
}

function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 403) return new JinnMcpToolError(`${what} refused (403): ${detail}`);
  if (status === 404) return new JinnMcpToolError(`${what} failed (404): not found`);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

function attachmentPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new JinnMcpToolError("path is required and must be an absolute local file path");
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new JinnMcpToolError("path must be normalized and contain no control bytes");
  }
  if (!path.isAbsolute(value)) throw new JinnMcpToolError("path must be absolute");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(value);
  } catch {
    throw new JinnMcpToolError(`attachment file not found: ${path.basename(value) || "file"}`);
  }
  if (!stat.isFile()) throw new JinnMcpToolError("path must point to a regular file");
  if (stat.size > ATTACHMENT_MAX_BYTES) throw new JinnMcpToolError("attachment exceeds the 50 MB limit");
  return value;
}

function attachmentCaption(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new JinnMcpToolError("caption must be a string when provided");
  if (value.length > ATTACHMENT_CAPTION_MAX_CHARS) {
    throw new JinnMcpToolError(`caption exceeds ${ATTACHMENT_CAPTION_MAX_CHARS} characters`);
  }
  return value;
}

export function buildFileTools(): JinnMcpTool[] {
  const list: JinnMcpTool = {
    name: "list_files",
    description: "List managed files.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const { status, body } = await gatewayGet(ctx, "/api/files");
      if (status >= 400) throw gatewayFailure("listing managed files", status, body);
      const rows = Array.isArray(body) ? body : [];
      const files = rows.slice(0, clampLimit(args.limit)).map((row) => {
        const meta = (row ?? {}) as FileMetaWire;
        return {
          id: meta.id ?? null,
          filename: meta.filename ?? null,
          size: meta.size ?? null,
          mimetype: meta.mimetype ?? null,
          createdAt: meta.createdAt ?? null,
          managedPath: managedPath(meta) ?? null,
        };
      });
      return { files, hint: files.length ? "Next: read_file { path: managedPath }." : "No managed files found." };
    },
  };

  const read: JinnMcpTool = {
    name: "read_file",
    description: "Read a managed file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler: async (args, ctx: JinnMcpContext) => {
      assertBoundCaller(ctx);
      const rel = shapeGateManagedPath(args.path);
      const { status, body } = await gatewayGet(ctx, `/api/files/read?path=${encodeManagedPath(rel)}`);
      if (status >= 400) throw gatewayFailure(`reading managed file "${rel}"`, status, body);
      const rec = (body ?? {}) as Record<string, unknown>;
      return {
        path: rec.path ?? rel,
        mime: rec.mime ?? null,
        size: rec.size ?? null,
        tooLarge: rec.tooLarge ?? false,
        binary: rec.binary ?? false,
        ...(rec.content !== undefined ? { content: rec.content } : {}),
      };
    },
  };

  const publish: JinnMcpTool = {
    name: "publish_attachment",
    description: "Publish a local file or image in this chat.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        caption: { type: "string" },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const localPath = attachmentPath(args.path);
      const filename = path.basename(localPath);
      const content = fs.readFileSync(localPath).toString("base64");
      const { status, body } = await gatewayRequest(
        ctx,
        "POST",
        `/api/sessions/${encodeURIComponent(ctx.callerSessionId)}/attachments`,
        { content, filename, text: attachmentCaption(args.caption) },
      );
      if (status >= 400) throw gatewayFailure(`publishing attachment "${filename}"`, status, body);
      const response = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const message = response.message && typeof response.message === "object"
        ? response.message as Record<string, unknown>
        : {};
      return {
        status: "published",
        filename,
        media: response.media ?? null,
        messageId: message.id ?? null,
      };
    },
  };

  return [list, read, publish];
}
