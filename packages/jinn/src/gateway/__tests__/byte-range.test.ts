import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseRangeHeader, streamFile } from "../byte-range.js";

class CaptureResponse extends Writable {
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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("parseRangeHeader", () => {
  it("parses bounded, open-ended, and suffix byte ranges", () => {
    expect(parseRangeHeader("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRangeHeader("bytes=6-", 10)).toEqual({ start: 6, end: 9 });
    expect(parseRangeHeader("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
  });

  it("rejects unsatisfiable, malformed, and multi-range requests", () => {
    expect(parseRangeHeader("bytes=10-12", 10)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=nope", 10)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=0-1,4-5", 10)).toBe("unsatisfiable");
  });
});

describe("streamFile", () => {
  function fixture(): { filePath: string; bytes: Buffer } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-byte-range-"));
    roots.push(root);
    const filePath = path.join(root, "clip.mp4");
    const bytes = Buffer.from("0123456789");
    fs.writeFileSync(filePath, bytes);
    return { filePath, bytes };
  }

  it("streams the exact requested slice with 206 headers", async () => {
    const { filePath } = fixture();
    const req = { method: "GET", headers: { range: "bytes=2-5" } } as unknown as IncomingMessage;
    const res = new CaptureResponse();

    await streamFile(req, res as unknown as ServerResponse, filePath, {
      mime: "video/mp4",
      filename: "clip.mp4",
      disposition: "inline",
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["Content-Range"]).toBe("bytes 2-5/10");
    expect(res.headers["Content-Length"]).toBe(4);
    expect(res.headers["Accept-Ranges"]).toBe("bytes");
    expect(res.bytes()).toEqual(Buffer.from("2345"));
  });

  it("advertises byte ranges on 200 and returns no body for HEAD", async () => {
    const { filePath, bytes } = fixture();
    const getRes = new CaptureResponse();
    await streamFile(
      { method: "GET", headers: {} } as unknown as IncomingMessage,
      getRes as unknown as ServerResponse,
      filePath,
      { mime: "video/mp4", filename: "clip.mp4", disposition: "inline" },
    );
    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers["Accept-Ranges"]).toBe("bytes");
    expect(getRes.bytes()).toEqual(bytes);

    const headRes = new CaptureResponse();
    await streamFile(
      { method: "HEAD", headers: {} } as unknown as IncomingMessage,
      headRes as unknown as ServerResponse,
      filePath,
      { mime: "video/mp4", filename: "clip.mp4", disposition: "inline" },
    );
    expect(headRes.statusCode).toBe(200);
    expect(headRes.headers["Content-Length"]).toBe(bytes.length);
    expect(headRes.bytes()).toHaveLength(0);
  });

  it("answers an unsatisfiable range with 416 and the complete size", async () => {
    const { filePath } = fixture();
    const res = new CaptureResponse();
    await streamFile(
      { method: "GET", headers: { range: "bytes=99-" } } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      filePath,
      { mime: "video/mp4", filename: "clip.mp4", disposition: "inline" },
    );
    expect(res.statusCode).toBe(416);
    expect(res.headers["Content-Range"]).toBe("bytes */10");
    expect(res.bytes()).toHaveLength(0);
  });
});
