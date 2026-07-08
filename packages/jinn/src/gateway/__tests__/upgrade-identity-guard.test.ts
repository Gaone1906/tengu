import { describe, expect, it } from "vitest";
import type http from "node:http";
import { rejectUnverifiedIdentifiedUpgradeCaller } from "../server.js";
import * as server from "../server.js";
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
  return { headers } as http.IncomingMessage;
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
});
