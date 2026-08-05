import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

export interface ByteRange {
  start: number;
  end: number;
}

export function parseRangeHeader(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  if (size <= 0) return "unsatisfiable";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "unsatisfiable";

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || start > requestedEnd) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export interface StreamFileOptions {
  mime: string;
  filename: string;
  disposition: "inline" | "attachment";
  cacheHeaders?: Record<string, string>;
}

function contentDisposition(disposition: StreamFileOptions["disposition"], filename: string): string {
  const safeFilename = filename.replace(/[^\w.\- ]/g, "_");
  return `${disposition}; filename="${safeFilename}"`;
}

export async function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options: StreamFileOptions,
): Promise<void> {
  const size = fs.statSync(filePath).size;
  const header = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
  const range = parseRangeHeader(header, size);
  const commonHeaders = {
    "Content-Type": options.mime,
    "Content-Disposition": contentDisposition(options.disposition, options.filename),
    "Accept-Ranges": "bytes",
    ...options.cacheHeaders,
  };

  if (range === "unsatisfiable") {
    res.writeHead(416, {
      ...commonHeaders,
      "Content-Range": `bytes */${size}`,
      "Content-Length": 0,
    });
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const contentLength = range ? end - start + 1 : size;
  res.writeHead(range ? 206 : 200, {
    ...commonHeaders,
    "Content-Length": contentLength,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(filePath, range ? { start, end } : undefined), res);
}
