import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const registryMock = vi.hoisted(() => ({
  markRunningQueueItemsCompletedForSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock("../../sessions/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/registry.js")>()),
  markRunningQueueItemsCompletedForSession: registryMock.markRunningQueueItemsCompletedForSession,
  updateSession: registryMock.updateSession,
}));

import { handleApiRequest, type ApiContext } from "../api.js";

function makeReq(
  method: string,
  url: string,
  opts: { authorization?: string; remoteAddress?: string; sessionId?: string } = {},
): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: "localhost",
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
    ...(opts.sessionId ? { "x-jinn-session-id": opts.sessionId } : {}),
  };
  (req as any).socket = { remoteAddress: opts.remoteAddress ?? "127.0.0.1" };
  return req;
}

function makeRes() {
  let status = 200;
  let chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
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

function ctx(restartGateway = vi.fn()): ApiContext {
  return {
    gatewayAuthToken: "gateway-token",
    restartGateway,
    getConfig: () => ({ gateway: { host: "127.0.0.1", port: 7777 }, engines: { default: "claude" } }),
    connectors: new Map(),
    startTime: Date.now(),
  } as unknown as ApiContext;
}

afterEach(() => {
  vi.useRealTimers();
  registryMock.markRunningQueueItemsCompletedForSession.mockReset();
  registryMock.updateSession.mockReset();
});

describe("POST /api/system/restart", () => {
  it("requires gateway authentication", async () => {
    const restartGateway = vi.fn();
    const cap = makeRes();

    await handleApiRequest(makeReq("POST", "/api/system/restart"), cap.res, ctx(restartGateway));

    expect(cap.status).toBe(403);
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("responds before scheduling the detached restart helper", async () => {
    vi.useFakeTimers();
    const restartGateway = vi.fn();
    const cap = makeRes();

    await handleApiRequest(
      makeReq("POST", "/api/system/restart", { authorization: "Bearer gateway-token" }),
      cap.res,
      ctx(restartGateway),
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ status: "restarting" });
    expect(restartGateway).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("completes the requesting session queue item before scheduling restart", async () => {
    vi.useFakeTimers();
    const restartGateway = vi.fn();
    const cap = makeRes();

    await handleApiRequest(
      makeReq("POST", "/api/system/restart", {
        authorization: "Bearer gateway-token",
        sessionId: "session-requesting-restart",
      }),
      cap.res,
      ctx(restartGateway),
    );

    expect(cap.status).toBe(200);
    expect(registryMock.markRunningQueueItemsCompletedForSession)
      .toHaveBeenCalledWith("session-requesting-restart");
    expect(registryMock.updateSession).toHaveBeenCalledWith(
      "session-requesting-restart",
      expect.objectContaining({
        status: "idle",
        lastError: null,
        transportMeta: expect.objectContaining({ restartAcknowledgedAt: expect.any(String) }),
      }),
    );
  });
});
