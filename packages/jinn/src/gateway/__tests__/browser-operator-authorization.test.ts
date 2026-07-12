import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { JinnConfig } from "../../shared/types.js";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-browser-operator-auth-"));
process.env.JINN_HOME = testHome;

fs.writeFileSync(
  path.join(testHome, "config.yaml"),
  `gateway:
  host: 127.0.0.1
engines:
  default: codex
  codex: {}
portal:
  portalName: Portal
  setupComplete: true
`,
);
fs.mkdirSync(path.join(testHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(testHome, "org", "operator.yaml"),
  "name: operator\ndisplayName: Operator\ndepartment: company\nrank: executive\nengine: codex\nmodel: default\npersona: Runs the organization.\n",
);

type Api = typeof import("../api.js");

let api: Api;
let server: http.Server;
let baseUrl: string;
let config: JinnConfig;
let lastRequestHeaders: http.IncomingHttpHeaders = {};

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "gateway-token",
  jinnHome: testHome,
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

async function needsAttention(headers: HeadersInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/work-items?needsAttentionFor=me&limit=10`, { headers });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function needsAttentionViaRawHttp(headers: http.OutgoingHttpHeaders): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL("/api/work-items?needsAttentionFor=me&limit=10", baseUrl);
  return await new Promise((resolve, reject) => {
    const request = http.request(target, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function sameOriginFetchHeaders(): Record<string, string> {
  return {
    accept: "*/*",
    referer: `${baseUrl}/todos`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36",
  };
}

beforeAll(async () => {
  api = await import("../api.js");
  const registry = await import("../../sessions/registry.js");
  registry.initDb();
  config = {
    gateway: { host: "127.0.0.1" },
    engines: { default: "codex", codex: {}, claude: {} },
  } as JinnConfig;

  server = http.createServer((req, res) => {
    lastRequestHeaders = req.headers;
    void api.handleApiRequest(req, res, context).catch((error: unknown) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("browser operator authorization", () => {
  it("recognizes an Origin-less same-origin browser fetch when gateway auth is disabled", async () => {
    const result = await needsAttention(sameOriginFetchHeaders());

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ workItems: [], total: 0, nextOffset: null });
    expect(lastRequestHeaders).toMatchObject({
      host: new URL(baseUrl).host,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    });
    expect(lastRequestHeaders.origin).toBeUndefined();
  });

  it.each([
    ["missing Fetch Metadata", {}],
    ["missing Fetch site", { "sec-fetch-mode": "cors" }],
    ["missing Fetch mode", { "sec-fetch-site": "same-origin" }],
    ["cross-site Fetch Metadata", { origin: "https://attacker.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }],
    ["navigation mode", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" }],
  ])("rejects an unauthenticated Origin-less or non-same-origin client with %s", async (_label, headers) => {
    const result = await needsAttentionViaRawHttp(headers);

    expect(result.status).toBe(403);
  });

  it("rejects same-origin metadata paired with a spoofed Host", async () => {
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      host: "attacker.example",
    });

    expect(result.status).toBe(403);
  });

  it("rejects inconsistent Origin and Host even when Fetch Metadata claims same-origin", async () => {
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      host: "attacker.example",
      origin: baseUrl,
    });

    expect(result.status).toBe(403);
  });

  it("does not treat Fetch Metadata as operator authentication when gateway auth is enabled", async () => {
    config = { ...config, gateway: { host: "127.0.0.1", authRequired: true } } as JinnConfig;
    try {
      const result = await needsAttention(sameOriginFetchHeaders());
      expect(result.status).toBe(403);
    } finally {
      config = { ...config, gateway: { host: "127.0.0.1" } } as JinnConfig;
    }
  });

  it("preserves credentialed API access without browser Fetch Metadata", async () => {
    config = { ...config, gateway: { host: "127.0.0.1", authRequired: true } } as JinnConfig;
    try {
      const result = await needsAttention({ authorization: "Bearer gateway-token", "user-agent": "api-client/1.0" });
      expect(result.status).toBe(200);
    } finally {
      config = { ...config, gateway: { host: "127.0.0.1" } } as JinnConfig;
    }
  });
});
