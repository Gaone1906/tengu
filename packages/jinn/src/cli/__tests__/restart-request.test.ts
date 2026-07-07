import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-request-test-"));
process.env.JINN_HOME = tmpHome;

const { requestRestartFromGateway } = await import("../restart-request.js");

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.JINN_SESSION_ID;
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "gateway.json"), JSON.stringify({
    port: 7780,
    host: "::1",
    pid: 123,
    secret: "hook-secret",
    token: "gateway-token",
  }));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("requestRestartFromGateway", () => {
  it("posts an authenticated restart request to the running gateway", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "restarting" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const ok = await requestRestartFromGateway(fetchMock as unknown as typeof fetch);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://[::1]:7780/api/system/restart",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("passes the current Jinn session id when available", async () => {
    process.env.JINN_SESSION_ID = "session-requesting-restart";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "restarting" }), { status: 200 }));

    const ok = await requestRestartFromGateway(fetchMock as unknown as typeof fetch);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://[::1]:7780/api/system/restart",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-jinn-session-id": "session-requesting-restart",
        }),
      }),
    );
  });

  it("returns false when the running gateway does not support the endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));

    await expect(requestRestartFromGateway(fetchMock as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("returns false when gateway connection metadata is unavailable", async () => {
    fs.rmSync(path.join(tmpHome, "gateway.json"), { force: true });
    const fetchMock = vi.fn();

    await expect(requestRestartFromGateway(fetchMock as unknown as typeof fetch)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
