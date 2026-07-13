import { describe, expect, it } from "vitest";
import type http from "node:http";
import { rejectUnverifiedIdentifiedUpgradeCaller } from "../server.js";
import * as server from "../server.js";
import { isSameOriginBrowserRequest } from "../api.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

class FakeUpgradeSocket {
  writes: string[] = [];
  destroyed = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function req(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const rawHeaders = Object.entries(headers).flatMap(([name, raw]) => {
    const values = Array.isArray(raw) ? raw : [raw];
    return values.flatMap((value) => value === undefined ? [] : [name, value]);
  });
  return {
    headers,
    rawHeaders,
    socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 7801 },
  } as http.IncomingMessage;
}

describe("WebSocket upgrade identity guard", () => {
  it("rejects tool-marked upgrades that do not carry a verified session capability", () => {
    const socket = new FakeUpgradeSocket();

    const rejected = rejectUnverifiedIdentifiedUpgradeCaller(
      req({ [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE }),
      socket,
      { sessionExists: (id) => id === "s-1" },
    );

    expect(rejected).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(socket.writes.join("")).toContain("403 Forbidden");
  });

  it("accepts operator/web upgrades that present no MCP identity headers", () => {
    const socket = new FakeUpgradeSocket();

    const rejected = rejectUnverifiedIdentifiedUpgradeCaller(req({}), socket, {
      sessionExists: (id) => id === "s-1",
    });

    expect(rejected).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it("accepts capability-bound tool upgrades", () => {
    const socket = new FakeUpgradeSocket();
    const capability = ensureSessionCapability("s-1");

    const rejected = rejectUnverifiedIdentifiedUpgradeCaller(
      req({
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: "s-1",
        [CALLER_SESSION_CAPABILITY_HEADER]: capability,
      }),
      socket,
      { sessionExists: (id) => id === "s-1" },
    );

    expect(rejected).toBe(false);
    expect(socket.destroyed).toBe(false);
  });
});

describe("PTY WebSocket upgrade authority", () => {
  it("rejects capability-bound callers instead of letting them inject PTY stdin", () => {
    const socket = new FakeUpgradeSocket();
    const capability = ensureSessionCapability("s-1");
    const guard = (server as any).rejectNonOperatorPtyUpgradeCaller;
    expect(typeof guard).toBe("function");

    const rejected = guard(
      req({
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: "s-1",
        [CALLER_SESSION_CAPABILITY_HEADER]: capability,
      }),
      socket,
      { sessionExists: (id: string) => id === "s-1" },
    );

    expect(rejected).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(socket.writes.join("")).toContain("403 Forbidden");
  });

  it("accepts a same-origin browser PTY upgrade via operator trust (CLI view fix)", () => {
    // A browser WebSocket sends an Origin but cannot send Authorization, so the
    // gateway grants operator identity via the same-origin fallback. Regression
    // guard for the empty-CLI-terminal bug (operator-only gate 403'd the view).
    const socket = new FakeUpgradeSocket();
    const guard = (server as any).rejectNonOperatorPtyUpgradeCaller;
    const headers = {
      host: "127.0.0.1:7801",
      origin: "http://127.0.0.1:7801",
      upgrade: "websocket",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "websocket",
      "sec-fetch-site": "same-origin",
    };
    const request = req(headers);
    const sameOrigin = isSameOriginBrowserRequest(request, { gateway: { host: "127.0.0.1" } } as never);
    expect(sameOrigin).toBe(true);

    const rejected = guard(request, socket, { operatorAuthenticated: sameOrigin });
    expect(rejected).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it("rejects a cross-origin browser PTY upgrade (no operator trust)", () => {
    const socket = new FakeUpgradeSocket();
    const guard = (server as any).rejectNonOperatorPtyUpgradeCaller;
    const headers = {
      host: "127.0.0.1:7801",
      origin: "http://evil.example",
      upgrade: "websocket",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "websocket",
      "sec-fetch-site": "same-origin",
    };
    const request = req(headers);
    const sameOrigin = isSameOriginBrowserRequest(request, { gateway: { host: "127.0.0.1" } } as never);
    expect(sameOrigin).toBe(false);

    const rejected = guard(request, socket, { operatorAuthenticated: sameOrigin });
    expect(rejected).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(socket.writes.join("")).toContain("403 Forbidden");
  });
});
