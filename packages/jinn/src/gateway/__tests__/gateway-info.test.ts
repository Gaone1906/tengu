import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatewayBaseUrl, writeGatewayInfo, readGatewayInfo, staleGatewayPids } from "../gateway-info.js";

describe("gateway-info", () => {
  it("writeGatewayInfo round-trips and generates a secret", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
    const file = path.join(dir, "gateway.json");
    const info = writeGatewayInfo(file, { port: 7777, host: "100.95.1.62", pid: 1234 });
    expect(info.port).toBe(7777);
    expect(info.host).toBe("100.95.1.62");
    expect(info.pid).toBe(1234);
    expect(typeof info.secret).toBe("string");
    expect(info.secret.length).toBeGreaterThanOrEqual(32);
    expect(readGatewayInfo(file)).toEqual(info);
  });

  it("readGatewayInfo returns null when the file is missing", () => {
    expect(readGatewayInfo("/nonexistent/gateway.json")).toBe(null);
  });

  it("ignores token-only gateway info when deriving stale pids to reap", () => {
    expect(staleGatewayPids({ token: "tok", namespace: "h1" } as any, 1234, "h1")).toEqual([]);
    expect(staleGatewayPids({ pid: undefined, ptyPids: [111, undefined, 1234, 0, -1], namespace: "h1" } as any, 1234, "h1")).toEqual([111]);
  });

  // A container restarts pids from 1, so pids recorded by a previous container
  // name unrelated live processes — reaping them could signal PID 1.
  it("does not reap pids recorded by a different namespace", () => {
    const info = { pid: 7, ptyPids: [14, 22], namespace: "old-container" } as any;
    expect(staleGatewayPids(info, 1234, "old-container")).toEqual([14, 22, 7]);
    expect(staleGatewayPids(info, 1234, "new-container")).toEqual([]);
  });

  it("does not reap pids from gateway info written before namespaces were recorded", () => {
    expect(staleGatewayPids({ pid: 7, ptyPids: [14] } as any, 1234, "h1")).toEqual([]);
  });

  it("writeGatewayInfo stamps the current namespace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
    const file = path.join(dir, "gateway.json");
    writeGatewayInfo(file, { port: 7777, pid: 1234 });
    expect(readGatewayInfo(file)!.namespace).toBe(os.hostname());
  });

  it("formats gateway URLs for network, wildcard, and IPv6 hosts", () => {
    expect(gatewayBaseUrl({ port: 7777, host: "100.95.1.62" })).toBe("http://100.95.1.62:7777");
    expect(gatewayBaseUrl({ port: 7777, host: "0.0.0.0" })).toBe("http://127.0.0.1:7777");
    expect(gatewayBaseUrl({ port: 7777, host: "::1" })).toBe("http://[::1]:7777");
  });
});
