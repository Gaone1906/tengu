import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { createHash } from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-cache-"));
process.env.JINN_HOME = tmp;

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");
type Paths = typeof import("../../shared/paths.js");

let files: Files;
let reg: Reg;
let paths: Paths;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  (await import("../../shared/db.js")).initDb();
});

describe("file cache helpers", () => {
  it("fileEtag is a strong tag from id + size", () => {
    expect(files.fileEtag("abc", 123)).toBe('"abc-123"');
  });

  it("isFileNotModified matches on If-None-Match (incl. weak prefix, lists, and *)", () => {
    const etag = '"abc-123"';
    expect(files.isFileNotModified({ "if-none-match": etag }, etag, 0)).toBe(true);
    expect(files.isFileNotModified({ "if-none-match": `W/${etag}` }, etag, 0)).toBe(true);
    expect(files.isFileNotModified({ "if-none-match": `"x-1", ${etag}` }, etag, 0)).toBe(true);
    expect(files.isFileNotModified({ "if-none-match": "*" }, etag, 0)).toBe(true);
    expect(files.isFileNotModified({ "if-none-match": '"other-9"' }, etag, 0)).toBe(false);
  });

  it("isFileNotModified honors If-Modified-Since at second precision", () => {
    const mtime = Date.parse("2026-05-30T12:00:00.000Z");
    expect(files.isFileNotModified({ "if-modified-since": "Sat, 30 May 2026 12:00:00 GMT" }, '"e"', mtime)).toBe(true);
    expect(files.isFileNotModified({ "if-modified-since": "Sat, 30 May 2026 11:59:59 GMT" }, '"e"', mtime)).toBe(false);
  });
});

// ── HTTP-level: GET returns 200 + cache headers, conditional GET returns 304 ──

function fakeReq(headers: Record<string, string>) {
  return { headers } as unknown as import("node:http").IncomingMessage;
}
function fakeRes() {
  const out: { status?: number; headers?: Record<string, unknown>; body?: unknown } = {};
  const res = new class extends Writable {
    _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      out.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      callback();
    }

    writeHead(status: number, headers?: Record<string, unknown>): this {
      out.status = status;
      out.headers = headers;
      return this;
    }

  }() as unknown as import("node:http").ServerResponse;
  return { res, out };
}
const ctx = { emit: () => {} } as unknown as import("../api.js").ApiContext;

class StreamResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string | number> = {};
  readonly chunks: Buffer[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  writeHead(statusCode: number, headers?: Record<string, string | number>): this {
    this.statusCode = statusCode;
    this.headers = headers ?? {};
    return this;
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

async function streamRequest(id: string, range: string): Promise<StreamResponse> {
  const res = new StreamResponse();
  await files.handleFilesRequest(
    { method: "GET", url: `/api/files/${id}`, headers: { range } } as unknown as import("node:http").IncomingMessage,
    res as unknown as import("node:http").ServerResponse,
    `/api/files/${id}`,
    "GET",
    ctx,
  );
  return res;
}

async function videoRequest(id: string, query = ""): Promise<StreamResponse> {
  const res = new StreamResponse();
  await files.handleFilesRequest(
    { method: "GET", url: `/api/files/${id}${query}`, headers: {} } as unknown as import("node:http").IncomingMessage,
    res as unknown as import("node:http").ServerResponse,
    `/api/files/${id}`,
    "GET",
    ctx,
  );
  return res;
}

describe("GET /api/files/:id caching", () => {
  let id: string;
  let etag: string;

  beforeAll(() => {
    id = "cachefile";
    const dir = path.join(paths.FILES_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from("cacheable-bytes");
    fs.writeFileSync(path.join(dir, "pic.png"), bytes);
    reg.insertFile({ id, filename: "pic.png", size: bytes.length, mimetype: "image/png", path: null });
    etag = files.fileEtag(id, bytes.length);
  });

  it("first GET returns 200 with immutable Cache-Control, ETag, Last-Modified + download header", async () => {
    const { res, out } = fakeRes();
    await files.handleFilesRequest(fakeReq({}), res, `/api/files/${id}`, "GET", ctx);
    expect(out.status).toBe(200);
    expect(out.headers!["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(out.headers!["ETag"]).toBe(etag);
    expect(out.headers!["Last-Modified"]).toBeTruthy();
    // caching is orthogonal — the download disposition is still set
    expect(String(out.headers!["Content-Disposition"])).toContain("attachment");
  });

  it("conditional GET with matching If-None-Match returns 304 and no body", async () => {
    const { res, out } = fakeRes();
    await files.handleFilesRequest(fakeReq({ "if-none-match": etag }), res, `/api/files/${id}`, "GET", ctx);
    expect(out.status).toBe(304);
    expect(out.headers!["ETag"]).toBe(etag);
    expect(out.headers!["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(out.body).toBeUndefined(); // res.end() called with no payload
  });

  it("serves the exact requested byte range and rejects an unsatisfiable one", async () => {
    const partial = await streamRequest(id, "bytes=2-6");
    expect(partial.statusCode).toBe(206);
    expect(partial.headers["Content-Range"]).toBe("bytes 2-6/15");
    expect(partial.headers["Accept-Ranges"]).toBe("bytes");
    expect(partial.bytes()).toEqual(Buffer.from("cheab"));

    const impossible = await streamRequest(id, "bytes=99-");
    expect(impossible.statusCode).toBe(416);
    expect(impossible.headers["Content-Range"]).toBe("bytes */15");
    expect(impossible.bytes()).toHaveLength(0);
  });

  it("serves video inline, forces original downloads, and adopts a cached low variant", async () => {
    const videoId = "cachevideo";
    const original = Buffer.alloc(1024, 7);
    const dir = path.join(paths.FILES_DIR, videoId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "clip.mp4"), original);
    reg.insertFile({ id: videoId, filename: "clip.mp4", size: original.length, mimetype: "video/mp4", path: null });

    const inline = await videoRequest(videoId);
    expect(inline.headers["Content-Disposition"]).toBe('inline; filename="clip.mp4"');
    expect(inline.headers["Accept-Ranges"]).toBe("bytes");

    const download = await videoRequest(videoId, "?download=1&quality=low");
    expect(download.headers["Content-Disposition"]).toBe('attachment; filename="clip.mp4"');
    expect(download.bytes()).toEqual(original);

    const fallback = await videoRequest(videoId, "?quality=low");
    expect(fallback.bytes()).toEqual(original);
    expect(fallback.headers["Cache-Control"]).toBe("no-store");

    const key = `file:${videoId}:${original.length}`;
    const cacheDir = path.join(paths.VIDEO_CACHE_DIR, createHash("sha256").update(key).digest("hex"));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "low.mp4"), Buffer.from("low"));
    const low = await videoRequest(videoId, "?quality=low");
    expect(low.bytes()).toEqual(Buffer.from("low"));
    expect(Number(low.headers["Content-Length"])).toBeLessThan(original.length);
  });
});
