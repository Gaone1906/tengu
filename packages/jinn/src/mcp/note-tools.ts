import path from "node:path";
import {
  assertBoundCaller,
  gatewayGet,
  gatewayRequest,
  JinnMcpToolError,
  type JinnMcpContext,
  type JinnMcpTool,
} from "./toolkit.js";

export const NOTE_QUERY_CHAR_CAP = 512;
export const NOTE_PATH_CHAR_CAP = 1_024;
const NOTE_TITLE_CHAR_CAP = 240;
const CONTROL_BYTES = /[\x00-\x1f\x7f]/;

function requiredString(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name];
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  if (normalized.length > max) throw new JinnMcpToolError(`${name} is too long (${normalized.length} chars, max ${max})`);
  return normalized;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new JinnMcpToolError(`${name} must be a string`);
  return value;
}

function validatePath(args: Record<string, unknown>): string {
  if (typeof args.path === "string" && CONTROL_BYTES.test(args.path)) {
    throw new JinnMcpToolError("path contains control bytes — pass a path returned by list_notes exactly");
  }
  const notePath = requiredString(args, "path", NOTE_PATH_CHAR_CAP);
  const relative = notePath.startsWith("knowledge/") ? notePath.slice("knowledge/".length) : "";
  const segments = relative.split("/");
  if (
    !relative
    || path.posix.isAbsolute(notePath)
    || path.posix.normalize(notePath) !== notePath
    || notePath.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
    || !segments.at(-1)?.endsWith(".md")
  ) {
    throw new JinnMcpToolError('path must be a safe relative Markdown path returned by list_notes, such as "knowledge/product/brief.md"');
  }
  return notePath;
}

function validateFolder(args: Record<string, unknown>): string | undefined {
  const folder = optionalString(args, "folder");
  if (folder === undefined || folder === "") return folder;
  if (
    CONTROL_BYTES.test(folder)
    || folder.includes("\\")
    || path.posix.isAbsolute(folder)
    || path.posix.normalize(folder) !== folder
    || folder.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new JinnMcpToolError('folder must be a safe knowledge-relative directory, such as "product/research"');
  }
  return folder;
}

function failureDetail(body: unknown): string {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : JSON.stringify(body);
  const record = body as Record<string, unknown>;
  const detail = typeof record.error === "string" ? record.error : JSON.stringify(body);
  return typeof record.currentRevision === "string" ? `${detail}; currentRevision=${record.currentRevision}` : detail;
}

function gatewayFailure(action: string, status: number, body: unknown): JinnMcpToolError {
  const detail = failureDetail(body);
  if (status === 409) return new JinnMcpToolError(`${action} conflict (409): ${detail}`);
  if (status === 403) return new JinnMcpToolError(`${action} refused (403): ${detail}`);
  if (status === 404) return new JinnMcpToolError(`${action} failed (404): ${detail}`);
  if (status === 400) return new JinnMcpToolError(`${action} rejected (400): ${detail}`);
  if (status === 413) return new JinnMcpToolError(`${action} rejected (413 too large): ${detail}`);
  return new JinnMcpToolError(`${action} failed (HTTP ${status}): ${detail}`);
}

async function checkedRequest(
  ctx: JinnMcpContext,
  method: "GET" | "POST" | "PUT",
  route: string,
  action: string,
  body?: unknown,
): Promise<unknown> {
  const response = method === "GET"
    ? await gatewayGet(ctx, route)
    : await gatewayRequest(ctx, method, route, body);
  if (response.status >= 400) throw gatewayFailure(action, response.status, response.body);
  return response.body;
}

export function buildNoteTools(): JinnMcpTool[] {
  const listNotes: JinnMcpTool = {
    name: "list_notes",
    description: "List Markdown Notes and folders; optional text query.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: [],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const rawQuery = optionalString(args, "query");
      const query = rawQuery?.trim();
      if (query && query.length > NOTE_QUERY_CHAR_CAP) {
        throw new JinnMcpToolError(`query is too long (${query.length} chars, max ${NOTE_QUERY_CHAR_CAP})`);
      }
      const route = query ? `/api/notes?q=${encodeURIComponent(query)}` : "/api/notes";
      const response = await checkedRequest(ctx, "GET", route, "listing notes") as Record<string, unknown>;
      return {
        ...response,
        hint: "Use read_note { path } before update_note; pass its revision as expectedRevision.",
      };
    },
  };

  const readNote: JinnMcpTool = {
    name: "read_note",
    description: "Read one Markdown Note and its revision.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const notePath = validatePath(args);
      return checkedRequest(ctx, "GET", `/api/notes/read?path=${encodeURIComponent(notePath)}`, "reading note");
    },
  };

  const createNote: JinnMcpTool = {
    name: "create_note",
    description: "Create a Markdown Note in knowledge/.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        folder: { type: "string" },
      },
      required: ["title"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const title = requiredString(args, "title", NOTE_TITLE_CHAR_CAP);
      if (CONTROL_BYTES.test(title)) throw new JinnMcpToolError("title must be one line without control bytes");
      const body = optionalString(args, "body");
      const folder = validateFolder(args);
      return checkedRequest(ctx, "POST", "/api/notes", "creating note", {
        title,
        ...(body !== undefined ? { body } : {}),
        ...(folder !== undefined ? { folder } : {}),
      });
    },
  };

  const updateNote: JinnMcpTool = {
    name: "update_note",
    description: "Update a Note using its expected revision.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedRevision: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        append: { type: "string" },
      },
      required: ["path", "expectedRevision"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const notePath = validatePath(args);
      const expectedRevision = requiredString(args, "expectedRevision", 64);
      if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
        throw new JinnMcpToolError("expectedRevision must be the SHA-256 revision returned by read_note");
      }
      const title = optionalString(args, "title");
      const body = optionalString(args, "body");
      const append = optionalString(args, "append");
      if (body !== undefined && append !== undefined) throw new JinnMcpToolError("body and append are mutually exclusive");
      if (title === undefined && body === undefined && append === undefined) {
        throw new JinnMcpToolError("at least one of title, body, or append is required");
      }
      return checkedRequest(ctx, "PUT", "/api/notes", "updating note", {
        path: notePath,
        expectedRevision,
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(append !== undefined ? { append } : {}),
      });
    },
  };

  return [listNotes, readNote, createNote, updateNote];
}
