import { describe, expect, it, vi } from "vitest";
import {
  cloneCurrentTailscaleServe,
  parseTailscaleServeStatus,
  resolveInstanceSwitchUrl,
} from "./access.js";

const serveStatus = JSON.stringify({
  TCP: { "443": { HTTPS: true }, "7801": { HTTPS: true } },
  Web: {
    "machine.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7777" } } },
    "machine.example.ts.net:7801": { Handlers: { "/": { Proxy: "http://127.0.0.1:7801" } } },
  },
});

describe("workspace access discovery", () => {
  it("maps Tailscale HTTPS listener ports back to internal workspace ports", () => {
    expect(parseTailscaleServeStatus(serveStatus)).toEqual([
      { internalPort: 7777, externalUrl: "https://machine.example.ts.net" },
      { internalPort: 7801, externalUrl: "https://machine.example.ts.net:7801" },
    ]);
  });

  it("prefers learned and provider URLs, then infers the current remote host, with loopback as local fallback", () => {
    const mappings = parseTailscaleServeStatus(serveStatus);
    expect(resolveInstanceSwitchUrl({
      instance: { port: 7777, accessUrls: { remote: "https://workspace.example.com" } },
      currentOrigin: "https://proxy.example.com",
      tailscaleMappings: mappings,
    })).toBe("https://workspace.example.com");
    expect(resolveInstanceSwitchUrl({
      instance: { port: 7777 },
      currentOrigin: "https://machine.example.ts.net:7801",
      tailscaleMappings: mappings,
    })).toBe("https://machine.example.ts.net");
    expect(resolveInstanceSwitchUrl({ instance: { port: 7788 }, currentOrigin: "https://gateway.example.com" })).toBe(
      "https://gateway.example.com:7788",
    );
    expect(resolveInstanceSwitchUrl({ instance: { port: 7788 }, currentOrigin: "http://127.0.0.1:7777" })).toBe(
      "http://127.0.0.1:7788",
    );
  });

  it("clones private Tailscale Serve only when the current workspace already has a mapping", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "serve" && args[1] === "status") return { stdout: serveStatus, stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const configured = await cloneCurrentTailscaleServe({ currentPort: 7777, newPort: 7788, execFile });
    expect(configured).toEqual({ status: "configured", url: "https://machine.example.ts.net:7788" });
    expect(execFile).toHaveBeenLastCalledWith("tailscale", [
      "serve", "--bg", "--yes", "--https=7788", "http://127.0.0.1:7788",
    ]);

    execFile.mockClear();
    const skipped = await cloneCurrentTailscaleServe({ currentPort: 7999, newPort: 7788, execFile });
    expect(skipped.status).toBe("not-detected");
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
