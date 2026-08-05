import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { Instance } from "../../instances/directory.js";
import { handleApiRequest, type ApiContext } from "../api.js";

function responseCapture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    body: () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as any,
  };
}

function request(method: string, url: string, body?: unknown, authorized = false): IncomingMessage {
  const encoded = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(encoded ? [Buffer.from(encoded)] : []), {
    method,
    url,
    headers: {
      host: "machine.example.ts.net:7801",
      origin: "https://machine.example.ts.net:7801",
      "content-type": "application/json",
      ...(authorized ? { authorization: "Bearer gateway-token" } : {}),
    },
    socket: { remoteAddress: "100.64.0.2" },
  });
  return req as unknown as IncomingMessage;
}

const current: Instance = {
  id: "current-id",
  name: "jinn-team",
  displayName: "Team",
  port: 7801,
  home: "/workspaces/team",
  createdAt: "2026-01-01T00:00:00.000Z",
  pinned: true,
};
const main: Instance = {
  id: "main-id",
  name: "jinn",
  displayName: "Main",
  port: 7777,
  home: "/workspaces/main",
  createdAt: "2026-01-01T00:00:00.000Z",
  pinned: true,
};
const stoppedLegacy: Instance = {
  id: "old-id",
  name: "jinn-old-test",
  displayName: "Old test",
  port: 7999,
  home: "/workspaces/old-test",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function context(overrides: Partial<ApiContext> = {}): ApiContext {
  return {
    gatewayAuthToken: "gateway-token",
    jinnHome: current.home,
    runtimePort: current.port,
    getConfig: () => ({ gateway: { port: current.port, host: "127.0.0.1", authRequired: true }, engines: { default: "codex" } }),
    connectors: new Map(),
    startTime: Date.now(),
    sessionManager: { getEngines: () => new Map(), getQueue: () => ({ getPendingCount: () => 0 }) },
    loadWorkspaceInstances: () => [main, current, stoppedLegacy],
    saveWorkspaceInstances: vi.fn(),
    checkWorkspaceRunning: async (instance: Instance) => instance.id !== stoppedLegacy.id,
    readWorkspaceAccessMappings: async () => [
      { internalPort: 7777, externalUrl: "https://machine.example.ts.net" },
      { internalPort: 7801, externalUrl: "https://machine.example.ts.net:7801" },
    ],
    ...overrides,
  } as unknown as ApiContext;
}

describe("workspace instance API", () => {
  it("lists active or pinned workspaces, identifies current by home, and returns ready-to-use URLs", async () => {
    const capture = responseCapture();
    await handleApiRequest(request("GET", "/api/instances"), capture.res, context());

    expect(capture.status()).toBe(200);
    expect(capture.body()).toEqual([
      expect.objectContaining({ id: "main-id", name: "jinn", displayName: "Main", running: true, current: false, switchUrl: "https://machine.example.ts.net/" }),
      expect.objectContaining({ id: "current-id", name: "jinn-team", displayName: "Team", running: true, current: true, switchUrl: "https://machine.example.ts.net:7801/" }),
    ]);
  });

  it("keeps creation operator-only and returns a one-time paired onboarding URL", async () => {
    const created: Instance = {
      id: "new-id",
      name: "jinn-john",
      displayName: "John",
      port: 7788,
      home: "/workspaces/john",
      createdAt: "2026-07-20T00:00:00.000Z",
      pinned: true,
      accessUrls: { remote: "https://machine.example.ts.net:7788" },
    };
    const createWorkspaceInstance = vi.fn(async () => ({ instance: created }));
    const issueWorkspacePairingCode = vi.fn(() => "ABCD-EFGH-JKLM");
    const ctx = context({ createWorkspaceInstance, issueWorkspacePairingCode } as Partial<ApiContext>);

    const denied = responseCapture();
    await handleApiRequest(request("POST", "/api/instances", { name: "John" }), denied.res, ctx);
    expect(denied.status()).toBe(403);
    expect(createWorkspaceInstance).not.toHaveBeenCalled();

    const capture = responseCapture();
    await handleApiRequest(request("POST", "/api/instances", { name: "John" }, true), capture.res, ctx);

    expect(capture.status()).toBe(201);
    expect(createWorkspaceInstance).toHaveBeenCalledWith({
      name: "John",
      port: undefined,
      currentPort: 7801,
      gatewayHost: "127.0.0.1",
      authRequired: true,
    });
    expect(issueWorkspacePairingCode).toHaveBeenCalledWith(created.home);
    expect(capture.body()).toMatchObject({
      instance: { id: "new-id", displayName: "John", running: true, current: false },
      launchUrl: "https://machine.example.ts.net:7788/?onboarding=1#jinn-pair=ABCD-EFGH-JKLM",
    });
  });

  // The container's binding must not follow a new workspace into its config.yaml: that
  // home outlives the container, and a workstation opening it later would bind every
  // interface. loadConfig() resolves JINN_HOST into the config this handler reads, so
  // the only way to tell "the user chose this" from "the environment did" is the
  // variable itself.
  it("does not copy an environment-resolved gateway.host into a new workspace", async () => {
    const previous = process.env.JINN_HOST;
    process.env.JINN_HOST = "0.0.0.0";
    try {
      const created: Instance = {
        id: "new-id",
        name: "jinn-john",
        displayName: "John",
        port: 7788,
        home: "/workspaces/john",
        createdAt: "2026-07-20T00:00:00.000Z",
        pinned: true,
        accessUrls: { remote: "https://machine.example.ts.net:7788" },
      };
      const createWorkspaceInstance = vi.fn(async () => ({ instance: created }));
      // What loadConfig() hands the gateway inside the container: the resolved binding.
      const ctx = context({
        createWorkspaceInstance,
        issueWorkspacePairingCode: vi.fn(() => "ABCD-EFGH-JKLM"),
        getConfig: () => ({ gateway: { port: 7801, host: "0.0.0.0", authRequired: true }, engines: { default: "codex" } }),
      } as unknown as Partial<ApiContext>);

      const capture = responseCapture();
      await handleApiRequest(request("POST", "/api/instances", { name: "John" }, true), capture.res, ctx);

      expect(capture.status()).toBe(201);
      expect(createWorkspaceInstance).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayHost: undefined }),
      );
    } finally {
      if (previous === undefined) delete process.env.JINN_HOST;
      else process.env.JINN_HOST = previous;
    }
  });

  it("keeps offline start operator-only and returns the started workspace URL", async () => {
    const started = { ...stoppedLegacy, pinned: true, accessUrls: { remote: "https://machine.example.ts.net:7999" } };
    const startWorkspaceInstance = vi.fn(async () => ({ instance: started }));
    const ctx = context({ startWorkspaceInstance } as Partial<ApiContext>);

    const denied = responseCapture();
    await handleApiRequest(request("POST", `/api/instances/${stoppedLegacy.id}/start`), denied.res, ctx);
    expect(denied.status()).toBe(403);
    expect(startWorkspaceInstance).not.toHaveBeenCalled();

    const capture = responseCapture();
    await handleApiRequest(request("POST", `/api/instances/${stoppedLegacy.id}/start`, undefined, true), capture.res, ctx);

    expect(capture.status()).toBe(200);
    expect(startWorkspaceInstance).toHaveBeenCalledWith({ instance: stoppedLegacy, currentPort: 7801 });
    expect(capture.body()).toMatchObject({
      id: stoppedLegacy.id,
      running: true,
      current: false,
      switchUrl: "https://machine.example.ts.net:7999/",
    });
  });
});
