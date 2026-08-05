import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatewayBaseUrl, readGatewayInfo, staleGatewayPids, writeGatewayInfo } from "../gateway-info.js";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";

describe("gateway-info", () => {
  it("round-trips gateway info, generates a secret, and records the reachable URL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
    const file = path.join(dir, "gateway.json");
    const info = writeGatewayInfo(file, { port: 7777, host: "100.95.1.62", pid: 1234 });
    expect(info).toMatchObject({
      port: 7777,
      host: "100.95.1.62",
      url: "http://100.95.1.62:7777",
      pid: 1234,
      ptyPids: [],
    });
    expect(info.secret.length).toBeGreaterThanOrEqual(32);
    expect(readGatewayInfo(file)).toEqual(info);
    expectPosixMode(fs.statSync(file), 0o600);
  });

  it("returns null when the file is missing", () => {
    expect(readGatewayInfo("/nonexistent/gateway.json")).toBe(null);
  });

  it("ignores token-only and invalid PID fields when deriving stale host PIDs", () => {
    expect(staleGatewayPids({ token: "tok" } as any, 1234)).toEqual([]);
    expect(staleGatewayPids({ pid: undefined, ptyPids: [111, undefined, 1234, 0, -1] } as any, 1234)).toEqual([111]);
  });

  it("formats gateway URLs for network, wildcard, fallback, and IPv6 hosts", () => {
    expect(gatewayBaseUrl({ port: 7777, host: "100.95.1.62" })).toBe("http://100.95.1.62:7777");
    expect(gatewayBaseUrl({ port: 7777, host: "0.0.0.0" })).toBe("http://127.0.0.1:7777");
    expect(gatewayBaseUrl({ port: 7777, host: "0.0.0.0" }, "::1")).toBe("http://[::1]:7777");
    expect(gatewayBaseUrl({ port: 7777, host: "::1" })).toBe("http://[::1]:7777");
  });
});
