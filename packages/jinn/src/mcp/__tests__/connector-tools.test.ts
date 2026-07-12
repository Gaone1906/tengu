import { describe, expect, it } from "vitest";
import { buildTools } from "../server.js";
import type { JinnMcpContext } from "../toolkit.js";

function tool(name: string) {
  const found = buildTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function boundCtx(fetchFn: typeof fetch): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    token: "tok",
    callerSessionId: "session-1",
    sessionCapability: "capability-1",
    fetchFn,
  };
}

describe("connector MCP tools", () => {
  it("sends through a configured connector with the bound tool identity", async () => {
    let request: { url: URL; init?: RequestInit } | undefined;
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      request = { url: new URL(typeof input === "string" ? input : input.toString()), init };
      return { status: 200, text: async () => JSON.stringify({ status: "sent" }) } as Response;
    }) as typeof fetch;

    const out = await tool("send_connector_message").handler(
      { connector: "slack", channel: "C123", text: "Ready for review", thread: "171.2" },
      boundCtx(fetchFn),
    );

    expect(request?.url.pathname).toBe("/api/connectors/slack/send");
    expect(request?.init?.method).toBe("POST");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      channel: "C123",
      text: "Ready for review",
      thread: "171.2",
    });
    expect(out).toEqual({ status: "sent", connector: "slack", channel: "C123" });
  });

  it("refuses connector sends without a bound caller identity", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return { status: 200, text: async () => "{}" } as Response;
    }) as typeof fetch;

    await expect(tool("send_connector_message").handler(
      { connector: "slack", channel: "C123", text: "Hello" },
      { gatewayUrl: "http://gateway.test", token: "tok", fetchFn },
    )).rejects.toThrow(/caller identity unavailable/i);
    expect(called).toBe(false);
  });
});
