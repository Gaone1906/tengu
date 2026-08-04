import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatewayBaseUrl, writeGatewayInfo, readGatewayInfo, staleGatewayPids, sameNamespace } from "../gateway-info.js";

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

  // Hostname AND boot identity: a reboot keeps the hostname while recycling every
  // pid, so the stamp has to change even though the machine has not.
  it("writeGatewayInfo stamps a namespace that is stable within one boot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
    const file = path.join(dir, "gateway.json");
    writeGatewayInfo(file, { port: 7777, pid: 1234 });
    const stamped = readGatewayInfo(file)!.namespace!;
    expect(stamped.startsWith(`${os.hostname()}:`)).toBe(true);
    expect(stamped.length).toBeGreaterThan(os.hostname().length + 1);

    const second = path.join(dir, "gateway-2.json");
    writeGatewayInfo(second, { port: 7778, pid: 1235 });
    expect(readGatewayInfo(second)!.namespace).toBe(stamped);
  });

  // A stamp from THIS boot must not match another machine's, nor the bare hostname
  // written by releases before the boot identity existed — the pids behind either
  // are somebody else's.
  it("the stamp writeGatewayInfo produces is foreign to another host and to the old format", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
    const file = path.join(dir, "gateway.json");
    writeGatewayInfo(file, { port: 7777, pid: 1234 });
    const stamped = readGatewayInfo(file)!.namespace!;

    expect(sameNamespace(stamped, stamped)).toBe(true);
    expect(sameNamespace(os.hostname(), stamped)).toBe(false);
    expect(sameNamespace(stamped, `other-host:${stamped.slice(stamped.indexOf(":") + 1)}`)).toBe(false);
    expect(staleGatewayPids({ pid: 7, ptyPids: [14], namespace: stamped } as any, 1234)).toEqual([14, 7]);
  });

  // The /proc-less form (macOS, Windows) derives the boot instant from uptime, whose
  // second granularity makes two reads of ONE boot differ by a tick. That is the only
  // difference it may absorb.
  describe("sameNamespace, derived boot instants", () => {
    it("treats a tick of uptime jitter as the same boot", () => {
      expect(sameNamespace("mac:boot-1700000000000", "mac:boot-1700000001500")).toBe(true);
      expect(sameNamespace("mac:boot-1700000001500", "mac:boot-1700000000000")).toBe(true);
    });

    // The case a bucketed identity got wrong: a reboot with less downtime than the
    // bucket landed on the same value, and the reaper then signalled pid numbers the
    // machine had already handed to somebody else.
    it("treats a short reboot as a different boot", () => {
      expect(sameNamespace("mac:boot-1700000000000", "mac:boot-1700000030000")).toBe(false);
      expect(staleGatewayPids(
        { pid: 7, ptyPids: [14, 22], namespace: "mac:boot-1700000000000" } as any,
        1234,
        "mac:boot-1700000030000",
      )).toEqual([]);
    });

    it("never crosses hostnames, however close the boot instants", () => {
      expect(sameNamespace("mac-a:boot-1700000000000", "mac-b:boot-1700000000000")).toBe(false);
    });

    it("compares the Linux boot_id + namespace inode form verbatim", () => {
      const bootId = "1e0f4b3a-0000-4000-8000-000000000000";
      expect(sameNamespace(`host:${bootId}/pid:[4026531836]`, `host:${bootId}/pid:[4026531836]`)).toBe(true);
      // Same host, same boot — a fresh pid namespace all the same (`docker restart`).
      expect(sameNamespace(`host:${bootId}/pid:[4026531836]`, `host:${bootId}/pid:[4026532001]`)).toBe(false);
    });

    it("treats an unparseable or absent namespace as foreign", () => {
      expect(sameNamespace(undefined, "mac:boot-1700000000000")).toBe(false);
      expect(sameNamespace("", "mac:boot-1700000000000")).toBe(false);
      expect(sameNamespace("mac", "mac:boot-1700000000000")).toBe(false);
      expect(sameNamespace("mac:boot-nonsense", "mac:boot-1700000000000")).toBe(false);
    });
  });

  it("formats gateway URLs for network, wildcard, and IPv6 hosts", () => {
    expect(gatewayBaseUrl({ port: 7777, host: "100.95.1.62" })).toBe("http://100.95.1.62:7777");
    expect(gatewayBaseUrl({ port: 7777, host: "0.0.0.0" })).toBe("http://127.0.0.1:7777");
    expect(gatewayBaseUrl({ port: 7777, host: "::1" })).toBe("http://[::1]:7777");
  });
});
