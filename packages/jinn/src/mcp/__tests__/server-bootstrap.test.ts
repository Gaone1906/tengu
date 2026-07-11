import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMcpServerBootstrap } from "../server-bootstrap.js";
import { verifySessionCapability } from "../identity.js";
import { resolveMcpSessionCapabilityKeyFile } from "../../shared/home.js";

describe("resolveMcpServerBootstrap", () => {
  it("recovers a complete scoped identity from non-secret argv when the engine strips all env", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-bootstrap-"));
    try {
      const result = resolveMcpServerBootstrap([
        "--jinn-session-id", "session-hermes",
        "--jinn-home", home,
        "--jinn-gateway-url", "http://127.0.0.1:7801",
      ]);

      expect(result).toMatchObject({
        callerSessionId: "session-hermes",
        gatewayUrl: "http://127.0.0.1:7801",
        jinnHome: home,
        sessionCapability: expect.any(String),
      });
      expect(verifySessionCapability(
        "session-hermes",
        result.sessionCapability!,
        resolveMcpSessionCapabilityKeyFile(home),
      )).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
