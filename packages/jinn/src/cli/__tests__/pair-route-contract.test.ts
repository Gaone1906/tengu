import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { handleApiRequest, type ApiContext } from "../../gateway/api.js";
import { createAuthSession } from "../../gateway/auth.js";
import { PAIRING_CHALLENGE_FILE_PREFIX } from "../../gateway/pairing-challenge.js";
import { enforceOwnerOnlyDirectory } from "../../shared/owner-only.js";
import {
  requestPairedDevices,
  requestPairingCode,
  requestUnpairDevice,
} from "../pair.js";

interface RouteObservation {
  method: string;
  pathname: string;
  authorization: string | null;
  proofPathsBeforeRoute: string[];
  responseBody?: unknown;
}

const tempHomes: string[] = [];

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pair-route-contract-"));
  enforceOwnerOnlyDirectory(home);
  tempHomes.push(home);
  return home;
}

function context(home: string): ApiContext {
  return {
    gatewayAuthToken: "gateway-token",
    jinnHome: home,
    getConfig: () => ({ gateway: { host: "0.0.0.0" }, engines: { default: "claude" } }),
    connectors: new Map(),
    startTime: Date.now(),
  } as unknown as ApiContext;
}

function makeRequest(
  method: string,
  pathname: string,
  body: unknown,
  headers: Headers,
  host: string,
): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = {
    host,
    ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
    ...(headers.get("content-type") ? { "content-type": headers.get("content-type")! } : {}),
  };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    setHeader() {
      return this;
    },
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function routeFetch(
  apiContext: ApiContext,
  home: string,
  observations: RouteObservation[],
  transformBody: (pathname: string, body: unknown) => unknown = (_pathname, body) => body,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const rawBody = init?.body === undefined ? undefined : String(init.body);
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const observation: RouteObservation = {
      method,
      pathname: url.pathname,
      authorization: headers.get("authorization"),
      proofPathsBeforeRoute: fs.readdirSync(home)
        .filter((name) => name.startsWith(PAIRING_CHALLENGE_FILE_PREFIX))
        .map((name) => path.join(home, name)),
    };
    observations.push(observation);

    const captured = makeResponse();
    await handleApiRequest(
      makeRequest(method, url.pathname, transformBody(url.pathname, body), headers, url.host),
      captured.res,
      apiContext,
    );
    observation.responseBody = captured.body;
    return new Response(JSON.stringify(captured.body), {
      status: captured.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of tempHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("pair CLI to gateway route contract", () => {
  it("mints through the exact filesystem challenge contract without bearer auth and always removes the proof", async () => {
    const successHome = tempHome();
    const successRequests: RouteObservation[] = [];
    const pairing = await requestPairingCode({
      port: 7799,
      jinnHome: successHome,
      fetchImpl: routeFetch(context(successHome), successHome, successRequests),
    });

    const challenge = successRequests[0].responseBody as { path: string };
    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(successRequests.map(({ pathname, authorization }) => ({ pathname, authorization }))).toEqual([
      { pathname: "/api/auth/pairing-challenges", authorization: null },
      { pathname: "/api/auth/pairing-codes", authorization: null },
    ]);
    expect(successRequests[1].proofPathsBeforeRoute).toEqual([challenge.path]);
    expect(fs.existsSync(challenge.path)).toBe(false);

    const failureHome = tempHome();
    const failureRequests: RouteObservation[] = [];
    await expect(requestPairingCode({
      port: 7799,
      jinnHome: failureHome,
      fetchImpl: routeFetch(context(failureHome), failureHome, failureRequests, (pathname, body) => {
        if (pathname !== "/api/auth/pairing-codes") return body;
        return { challengeId: "missing-challenge" };
      }),
    })).rejects.toThrow("Missing, invalid, expired, or already used pairing challenge");
    const failedChallenge = failureRequests[0].responseBody as { path: string };
    expect(failureRequests[1].proofPathsBeforeRoute).toEqual([failedChallenge.path]);
    expect(failureRequests.every(({ authorization }) => authorization === null)).toBe(true);
    expect(fs.existsSync(failedChallenge.path)).toBe(false);

    const bearerHome = tempHome();
    const bearerResponse = await routeFetch(context(bearerHome), bearerHome, [])(
      "http://127.0.0.1:7799/api/auth/pairing-codes",
      {
        method: "POST",
        headers: { authorization: "Bearer gateway-token", "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(bearerResponse.status).toBe(403);
  });

  it("lists and removes paired devices through the bearer-authenticated routes", async () => {
    const home = tempHome();
    const apiContext = context(home);
    const session = createAuthSession(
      home,
      { headers: { "user-agent": "Contract browser" }, socket: { remoteAddress: "100.64.1.2" } } as IncomingMessage,
      { kind: "remote" },
    );
    const requests: RouteObservation[] = [];
    const fetchImpl = routeFetch(apiContext, home, requests);

    const before = await requestPairedDevices({ port: 7799, token: "gateway-token", fetchImpl });
    expect(before.map(({ id }) => id)).toContain(session.device.id);

    const removed = await requestUnpairDevice({
      port: 7799,
      token: "gateway-token",
      deviceId: session.device.id,
      fetchImpl,
    });
    expect(removed).toEqual({ status: "ok", current: false });

    const after = await requestPairedDevices({ port: 7799, token: "gateway-token", fetchImpl });
    expect(after.map(({ id }) => id)).not.toContain(session.device.id);
    expect(requests.map(({ method, pathname, authorization }) => ({ method, pathname, authorization }))).toEqual([
      { method: "GET", pathname: "/api/auth/devices", authorization: "Bearer gateway-token" },
      { method: "DELETE", pathname: `/api/auth/devices/${session.device.id}`, authorization: "Bearer gateway-token" },
      { method: "GET", pathname: "/api/auth/devices", authorization: "Bearer gateway-token" },
    ]);
  });

  it("deletes expired and mismatched route proof files as terminal failures", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const home = tempHome();
    const fetchImpl = routeFetch(context(home), home, []);
    const createChallenge = async () => {
      const response = await fetchImpl("http://127.0.0.1:7799/api/auth/pairing-challenges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.json() as Promise<{ challengeId: string; nonce: string; path: string }>;
    };

    const expired = await createChallenge();
    fs.writeFileSync(expired.path, expired.nonce, { mode: 0o600 });
    now.mockReturnValue(11_001);
    const expiredResponse = await fetchImpl("http://127.0.0.1:7799/api/auth/pairing-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: expired.challengeId }),
    });
    expect(expiredResponse.status).toBe(403);
    expect(fs.existsSync(expired.path)).toBe(false);

    now.mockReturnValue(20_000);
    const mismatch = await createChallenge();
    fs.writeFileSync(mismatch.path, "wrong nonce", { mode: 0o600 });
    const mismatchResponse = await fetchImpl("http://127.0.0.1:7799/api/auth/pairing-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: mismatch.challengeId }),
    });
    expect(mismatchResponse.status).toBe(403);
    expect(fs.existsSync(mismatch.path)).toBe(false);

    fs.writeFileSync(mismatch.path, mismatch.nonce, { mode: 0o600 });
    const replay = await fetchImpl("http://127.0.0.1:7799/api/auth/pairing-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: mismatch.challengeId }),
    });
    expect(replay.status).toBe(403);
  });
});
