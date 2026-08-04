import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

// Point JINN_HOME at a temp dir BEFORE importing the module under test so
// readPathCandidates resolves the relative-path ordering against it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-read-home-"));
process.env.JINN_HOME = tmpHome;

type Files = typeof import("../files.js");
type Registry = typeof import("../../sessions/registry.js");
type Identity = typeof import("../../mcp/identity.js");
let files: Files;
let registry: Registry;
let identity: Identity;
let fileSession: import("../../shared/types.js").Session;

beforeAll(async () => {
  files = await import("../files.js");
  registry = await import("../../sessions/registry.js");
  identity = await import("../../mcp/identity.js");
  (await import("../../shared/db.js")).initDb();
  fileSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "file-reader", employee: "file-reader" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPathCandidates — resolution order", () => {
  it("managed relative path: files/ and uploads/ are the only readable roots", () => {
    const rel = "files/demo-project-design.md";
    const candidates = files.readPathCandidates(rel);

    expect(candidates[0]).toBe(path.resolve(tmpHome, rel));
    expect(candidates).toEqual([path.resolve(tmpHome, rel)]);
  });

  it("absolute, home-relative, and non-managed relative paths have no candidates", () => {
    const abs = "/etc/hosts";
    expect(files.readPathCandidates(abs)).toEqual([]);
    expect(files.readPathCandidates("~/some/file.txt")).toEqual([]);
    expect(files.readPathCandidates("knowledge/file.md")).toEqual([]);
    expect(files.readPathCandidates("config.yaml")).toEqual([]);
  });

  it("empty/whitespace path yields no candidates", () => {
    expect(files.readPathCandidates("")).toEqual([]);
    expect(files.readPathCandidates("   ")).toEqual([]);
  });
});

describe("resolveReadPath — first existing file wins", () => {
  it("resolves a valid managed file under JINN_HOME/files", () => {
    const rel = "files/artifact-only-in-managed-files.md";
    const inHome = path.resolve(tmpHome, rel);
    fs.mkdirSync(path.dirname(inHome), { recursive: true });
    fs.writeFileSync(inHome, "hello");

    const { resolvedPath, candidates } = files.resolveReadPath(rel);
    expect(resolvedPath).toBe(fs.realpathSync.native(inHome));
    expect(candidates[0]).toBe(inHome);
  });

  it("returns null when no candidate exists", () => {
    const { resolvedPath } = files.resolveReadPath("definitely/missing/nope-12345.xyz");
    expect(resolvedPath).toBeNull();
  });

  it("ignores a directory candidate (not a regular file)", () => {
    const dirRel = "files/a-directory-not-a-file";
    fs.mkdirSync(path.resolve(tmpHome, dirRel), { recursive: true });
    const { resolvedPath } = files.resolveReadPath(dirRel);
    expect(resolvedPath).toBeNull();
  });

  it("rejects the full escape battery before content can be read", () => {
    const canary = path.join(tmpHome, "canary-secret.txt");
    fs.writeFileSync(canary, "CANARY-SECRET-GRS-020E");
    const secretDir = path.join(tmpHome, "secrets");
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, "api-keys.json");
    fs.writeFileSync(secret, "CANARY-SECRET-GRS-020E");
    const link = path.join(tmpHome, "files", "escape.txt");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(secret, link);

    for (const bad of [
      "../canary-secret.txt",
      "files/../../canary-secret.txt",
      canary,
      "files/ok.txt\u0000",
      "files\\ok.txt",
      "files/%2e%2e/canary-secret.txt",
      "files/escape.txt",
    ]) {
      const result = files.resolveReadPath(bad);
      expect(result.resolvedPath, bad).toBeNull();
    }
  });
});

describe("/api/files/read containment — real route", () => {
  const ctx = {
    getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
    emit: () => {},
  } as any;

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
      get body() {
        return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
      },
    };
  }

  function toolHeaders(): Record<string, string> {
    return {
      [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
      [identity.CALLER_SESSION_HEADER]: fileSession.id,
      [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(fileSession.id),
    };
  }

  async function call(rawPath: string, headers: Record<string, string> = toolHeaders()) {
    const req = Object.assign(Readable.from([]), {
      method: "GET",
      url: `/api/files/read?path=${rawPath}`,
      headers: { host: "gateway.test", ...headers },
    });
    const cap = makeRes();
    await files.handleFilesRequest(req as any, cap.res, "/api/files/read", "GET", ctx);
    return cap;
  }

  async function list(headers: Record<string, string>) {
    const req = Object.assign(Readable.from([]), {
      method: "GET",
      url: "/api/files",
      headers: { host: "gateway.test", ...headers },
    });
    const cap = makeRes();
    await files.handleFilesRequest(req as any, cap.res, "/api/files", "GET", ctx);
    return cap;
  }

  async function postJson(pathname: string, body: unknown, headers: Record<string, string> = toolHeaders(), context = ctx) {
    const payload = Buffer.from(JSON.stringify(body));
    const req = Object.assign(Readable.from([payload]), {
      method: "POST",
      url: pathname,
      headers: {
        host: "gateway.test",
        "content-type": "application/json",
        "content-length": String(payload.length),
        ...headers,
      },
    });
    const cap = makeRes();
    await files.handleFilesRequest(req as any, cap.res, pathname, "POST", context);
    return cap;
  }

  async function deleteFileRoute(fileId: string, headers: Record<string, string> = toolHeaders()) {
    const pathname = `/api/files/${fileId}`;
    const req = Object.assign(Readable.from([]), {
      method: "DELETE",
      url: pathname,
      headers: { host: "gateway.test", ...headers },
    });
    const cap = makeRes();
    await files.handleFilesRequest(req as any, cap.res, pathname, "DELETE", ctx);
    return cap;
  }

  async function attachJson(body: unknown, headers: Record<string, string> = toolHeaders()) {
    const payload = Buffer.from(JSON.stringify(body));
    const req = Object.assign(Readable.from([payload]), {
      method: "POST",
      url: `/api/sessions/${fileSession.id}/attachments`,
      headers: {
        host: "gateway.test",
        "content-type": "application/json",
        "content-length": String(payload.length),
        ...headers,
      },
    });
    const cap = makeRes();
    await files.handleSessionAttachment(req as any, cap.res, fileSession.id, ctx);
    return cap;
  }

  it("fails closed for tool-marked list/read requests without a valid session capability", async () => {
    fs.mkdirSync(path.join(tmpHome, "files"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, "files", "visible.txt"), "visible");
    const noCapability = { [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE };

    const listed = await list(noCapability);
    expect(listed.status).toBe(403);
    expect(JSON.stringify(listed.body)).toMatch(/caller identity unavailable/i);

    const read = await call("files/visible.txt", noCapability);
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.body)).toMatch(/caller identity unavailable/i);
    expect(JSON.stringify(read.body)).not.toContain("visible");
  });

  it("allows a valid in-root managed read", async () => {
    const rel = "files/allowed.txt";
    fs.mkdirSync(path.join(tmpHome, "files"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, rel), "allowed content");
    const res = await call(rel);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: rel, content: "allowed content", binary: false });
  });

  it("refuses traversal, absolute, NUL, symlink-out, backslash, and encoded separator attempts without leaking the canary", async () => {
    const canaryText = "CANARY-SECRET-ROUTE-GRS-020E";
    const canary = path.join(tmpHome, "canary-route-secret.txt");
    fs.writeFileSync(canary, canaryText);
    const secret = path.join(tmpHome, "secrets", "api-keys.json");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, canaryText);
    const link = path.join(tmpHome, "files", "route-escape.txt");
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(secret, link);

    const attempts = [
      "../canary-route-secret.txt",
      "files/../../canary-route-secret.txt",
      canary,
      "files/allowed.txt%00",
      "files\\allowed.txt",
      "files%2F..%2Fcanary-route-secret.txt",
      "files/route-escape.txt",
    ];
    for (const attempt of attempts) {
      const res = await call(attempt);
      expect([400, 403, 404], attempt).toContain(res.status);
      expect(JSON.stringify(res.body), attempt).not.toContain(canaryText);
    }
  });

  it("does not reopen an authorized path after a symlink swap at read time (GRS-020e Codex QA TOCTOU)", async () => {
    const safeRel = "files/race.txt";
    const safePath = path.join(tmpHome, safeRel);
    const outside = path.join(tmpHome, "outside-canary.txt");
    const canaryText = "CANARY-CODEX-GRS-020E-OUTSIDE";
    fs.mkdirSync(path.dirname(safePath), { recursive: true });
    fs.writeFileSync(safePath, "safe original");
    fs.writeFileSync(outside, canaryText);

    const originalReadFileSync = fs.readFileSync;
    let swapped = false;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (!swapped && (typeof p === "number" || (typeof p === "string" && path.basename(p) === "race.txt"))) {
        swapped = true;
        fs.unlinkSync(safePath);
        fs.symlinkSync(outside, safePath);
      }
      return (originalReadFileSync as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof fs.readFileSync);

    const res = await call(safeRel);
    expect(JSON.stringify(res.body)).not.toContain(canaryText);
    expect(res.status).not.toBe(200);
  });

  it("rejects capability-bound path attachments before reading local files", async () => {
    const secret = path.join(tmpHome, "secrets", "api-keys.json");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "CANARY-PATH-ATTACH-SECRET");

    const res = await attachJson({ path: secret, text: "attach this" });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/operator/i);
    expect(JSON.stringify(res.body)).not.toContain("CANARY-PATH-ATTACH-SECRET");
  });

  it("rejects capability-bound file transfers before resolving local filesystem paths", async () => {
    const secret = path.join(tmpHome, "secrets", "api-keys.json");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "CANARY-FILE-TRANSFER-SECRET");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ id: "remote-file" }),
    } as Response);
    const transferCtx = {
      ...ctx,
      getConfig: () => ({
        gateway: {},
        engines: { default: "codex" },
        sessions: {},
        remotes: { remote: { url: "https://remote.example.test", token: "remote-token" } },
      }),
    } as any;

    const res = await postJson("/api/files/transfer", { destination: "remote", file: secret }, toolHeaders(), transferCtx);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/operator/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects loopback URL uploads before the server fetches them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("loopback"),
    } as unknown as Response);

    const res = await postJson("/api/files", { filename: "ssrf.txt", url: "http://127.0.0.1:1/private" }, {});

    expect([400, 403]).toContain(res.status);
    expect(JSON.stringify(res.body)).toMatch(/url|ssrf|loopback|private/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost.:1/private",
    "http://[::ffff:127.0.0.1]:1/private",
    "http://[::127.0.0.1]:1/private",
    "http://[::10.0.0.1]:1/private",
    "http://192.0.2.1:1/private",
    "http://198.51.100.1:1/private",
    "http://203.0.113.1:1/private",
    "http://192.0.0.8:1/private",
    "http://192.88.99.1:1/private",
  ])("rejects loopback URL aliases before fetch: %s", async (url) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("loopback"),
    } as unknown as Response);

    const upload = await postJson("/api/files", { filename: "ssrf.txt", url }, {});
    const attachment = await attachJson({ filename: "ssrf.txt", url }, {});

    expect(upload.status).toBe(400);
    expect(attachment.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects hostname URLs before fetch to avoid DNS rebinding", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("hostname"),
    } as unknown as Response);

    const res = await postJson("/api/files", { filename: "ssrf.txt", url: "https://example.com/private" }, {});

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/literal public IP|dns rebinding/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    "http://192.0.3.1/file.txt",
    "http://192.88.100.1/file.txt",
    "http://198.51.101.1/file.txt",
    "http://203.0.114.1/file.txt",
  ])("allows adjacent public IPv4 literals to reach fetch: %s", async (url) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from("public literal"),
    } as unknown as Response);

    const upload = await postJson("/api/files", { filename: "public.txt", url }, {});
    const attachment = await attachJson({ filename: "public.txt", url }, {});

    expect(upload.status).toBe(201);
    expect(attachment.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://127.0.0.1:1/private",
    "http://[::127.0.0.1]:1/private",
    "http://192.0.2.1:1/private",
  ])("rejects redirects to private addresses before following them: %s", async (location) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 302,
      statusText: "Found",
      headers: new Headers({ location }),
      arrayBuffer: async () => Buffer.from("redirect"),
    } as unknown as Response);

    const res = await postJson("/api/files", { filename: "ssrf.txt", url: "http://93.184.216.34/start" }, {});

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/loopback|private|non-public/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects capability-bound managed file deletes", async () => {
    const fileId = "delete-deny-file";
    const dir = path.join(tmpHome, "files", fileId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.txt"), "delete me only by operator");
    registry.insertFile({ id: fileId, filename: "note.txt", size: 26, mimetype: "text/plain", path: null });

    const res = await deleteFileRoute(fileId);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/operator/i);
    expect(registry.getFile(fileId)).toBeTruthy();
    expect(fs.existsSync(path.join(dir, "note.txt"))).toBe(true);
  });
});

describe("classifyFile — size cap + binary detection", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-classify-"));
  });

  it("returns utf-8 content for a small text file", () => {
    const f = path.join(dir, "note.md");
    fs.writeFileSync(f, "# Hello\nworld");
    const c = files.classifyFile(f);
    expect(c.binary).toBe(false);
    expect(c.tooLarge).toBe(false);
    expect(c.mime).toBe("text/markdown");
    expect(c.content).toBe("# Hello\nworld");
    expect(c.size).toBe(Buffer.byteLength("# Hello\nworld"));
  });

  it("flags binary by MIME (png) without reading content", () => {
    const f = path.join(dir, "img.png");
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const c = files.classifyFile(f);
    expect(c.binary).toBe(true);
    expect(c.content).toBeUndefined();
    expect(c.mime).toBe("image/png");
  });

  it("flags binary by NUL byte even with a text-ish extension", () => {
    const f = path.join(dir, "weird.txt");
    fs.writeFileSync(f, Buffer.from([0x68, 0x69, 0x00, 0x21]));
    const c = files.classifyFile(f);
    expect(c.binary).toBe(true);
    expect(c.content).toBeUndefined();
  });

  it("flags tooLarge for files over MAX_READ_SIZE without reading content", () => {
    const f = path.join(dir, "big.txt");
    fs.writeFileSync(f, Buffer.alloc(files.MAX_READ_SIZE + 1, 0x41)); // 'A' * (cap+1)
    const c = files.classifyFile(f);
    expect(c.tooLarge).toBe(true);
    expect(c.binary).toBe(false);
    expect(c.content).toBeUndefined();
    expect(c.size).toBe(files.MAX_READ_SIZE + 1);
  });
});
