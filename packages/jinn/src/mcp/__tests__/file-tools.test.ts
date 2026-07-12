import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnMcpContext } from "../toolkit.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-files-"));
process.env.JINN_HOME = tmpHome;

type FileTools = typeof import("../file-tools.js");
type Files = typeof import("../../gateway/files.js");
type Registry = typeof import("../../sessions/registry.js");
type Identity = typeof import("../identity.js");

let fileTools: FileTools;
let files: Files;
let registry: Registry;
let identity: Identity;
let fileSession: import("../../shared/types.js").Session;

beforeAll(async () => {
  fileTools = await import("../file-tools.js");
  files = await import("../../gateway/files.js");
  registry = await import("../../sessions/registry.js");
  identity = await import("../identity.js");
  registry.initDb();
  fileSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "file-reader", employee: "file-reader" });
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

function routeFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url.pathname + url.search);
    const req = Object.assign(Readable.from([]), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers: { host: url.host, ...Object.fromEntries(new Headers(init?.headers).entries()) },
    });
    const cap = makeRes();
    await files.handleFilesRequest(req as any, cap.res, url.pathname, init?.method ?? "GET", {
      getConfig: () => ({ gateway: {}, engines: {} }),
      emit: () => {},
    } as any);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

function tool(name: string) {
  const t = fileTools.buildFileTools().find((candidate) => candidate.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

function boundCtx(fetchFn: typeof fetch): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    token: "tok",
    callerSessionId: fileSession.id,
    sessionCapability: identity.ensureSessionCapability(fileSession.id),
    fetchFn,
  };
}

describe("managed file MCP tools", () => {
  it("publishes a local file only into the bound caller session", async () => {
    const screenshot = path.join(tmpHome, "review.png");
    const bytes = Buffer.from("test-image-bytes");
    fs.writeFileSync(screenshot, bytes);
    let request: { url: URL; init?: RequestInit } | undefined;
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      request = { url: new URL(typeof input === "string" ? input : input.toString()), init };
      return {
        status: 201,
        text: async () => JSON.stringify({
          id: "file-1",
          media: { type: "image", url: "/api/files/file-1", name: "review.png" },
        }),
      } as Response;
    }) as typeof fetch;

    const out = await tool("publish_attachment").handler(
      { path: screenshot, caption: "Review board" },
      boundCtx(fetchFn),
    ) as Record<string, unknown>;

    expect(request?.url.pathname).toBe(`/api/sessions/${fileSession.id}/attachments`);
    expect(request?.init?.method).toBe("POST");
    const body = JSON.parse(String(request?.init?.body));
    expect(body).toEqual({
      content: bytes.toString("base64"),
      filename: "review.png",
      text: "Review board",
    });
    expect(out).toMatchObject({ status: "published", filename: "review.png" });
    expect(JSON.stringify(out)).not.toContain(screenshot);
  });

  it("refuses attachment publishing before reading when caller identity is absent", async () => {
    const screenshot = path.join(tmpHome, "unbound.png");
    fs.writeFileSync(screenshot, "must-not-be-read");
    const calls: string[] = [];
    const ctx = { gatewayUrl: "http://gateway.test", token: "tok", fetchFn: routeFetch(calls) };

    await expect(tool("publish_attachment").handler({ path: screenshot }, ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses list/read locally when the MCP server has no bound caller identity", async () => {
    const calls: string[] = [];
    const ctx = { gatewayUrl: "http://gateway.test", token: "tok", fetchFn: routeFetch(calls) };

    await expect(tool("list_files").handler({ limit: 10 }, ctx)).rejects.toThrow(/caller identity unavailable/i);
    await expect(tool("read_file").handler({ path: "files/visible.txt" }, ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(calls).toHaveLength(0);
  });

  it("lists only managed relative paths and never leaks stored absolute paths", async () => {
    const filesDir = path.join(tmpHome, "files", "file-one");
    const uploadsDir = path.join(tmpHome, "uploads", "2026-07-06", "session-one");
    fs.mkdirSync(filesDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, "note.txt"), "note");
    fs.writeFileSync(path.join(uploadsDir, "upload.txt"), "upload");
    registry.insertFile({ id: "file-one", filename: "note.txt", size: 4, mimetype: "text/plain", path: null });
    registry.insertFile({ id: "file-two", filename: "upload.txt", size: 6, mimetype: "text/plain", path: path.join(uploadsDir, "upload.txt") });

    const calls: string[] = [];
    const out = (await tool("list_files").handler(
      { limit: 10 },
      boundCtx(routeFetch(calls)),
    )) as { files: Array<Record<string, unknown>> };

    expect(calls).toEqual(["/api/files"]);
    expect(out.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "file-one", filename: "note.txt", managedPath: "files/file-one/note.txt" }),
        expect.objectContaining({ id: "file-two", filename: "upload.txt", managedPath: "uploads/2026-07-06/session-one/upload.txt" }),
      ]),
    );
    expect(JSON.stringify(out)).not.toContain(tmpHome);
  });

  it("reads a managed file through the existing route without encoding slash separators", async () => {
    fs.mkdirSync(path.join(tmpHome, "files"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, "files", "ok.txt"), "managed content");
    const calls: string[] = [];

    const out = (await tool("read_file").handler(
      { path: "files/ok.txt" },
      boundCtx(routeFetch(calls)),
    )) as { path: string; content: string };

    expect(calls).toEqual(["/api/files/read?path=files/ok.txt"]);
    expect(out).toMatchObject({ path: "files/ok.txt", content: "managed content" });
  });

  it("rejects local shape violations before any HTTP call", async () => {
    const attempts = ["", " files/ok.txt", "/tmp/secret.txt", "~/secret.txt", "knowledge/note.md", "files/../secret.txt", "files\\ok.txt", "files/ok.txt\u0000"];
    for (const attempt of attempts) {
      const calls: string[] = [];
      await expect(
        tool("read_file").handler({ path: attempt }, boundCtx(routeFetch(calls))),
      ).rejects.toThrow(/managed|path|control|relative|slash|normalized/i);
      expect(calls, attempt).toHaveLength(0);
    }
  });

  it("keeps the route containment battery canary-safe through MCP", async () => {
    const canary = "CANARY-MCP-FILE-TOOLS";
    const secretDir = path.join(tmpHome, "secrets");
    const filesDir = path.join(tmpHome, "files");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "api-keys.json"), canary);
    try { fs.unlinkSync(path.join(filesDir, "leaf-link.txt")); } catch {}
    fs.symlinkSync(path.join(secretDir, "api-keys.json"), path.join(filesDir, "leaf-link.txt"));
    try { fs.unlinkSync(path.join(filesDir, "dir-link")); } catch {}
    fs.symlinkSync(secretDir, path.join(filesDir, "dir-link"));

    for (const attempt of ["files/leaf-link.txt", "files/dir-link/api-keys.json"]) {
      await expect(
        tool("read_file").handler({ path: attempt }, boundCtx(routeFetch())),
      ).rejects.toThrow(/403|symlink|outside|not readable/i);
    }
  });
});
