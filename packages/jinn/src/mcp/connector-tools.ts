import { assertBoundCaller, gatewayRequest, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import { CONNECTOR_ID_REQUIREMENTS, isValidConnectorId } from "../shared/connector-id.js";

function requiredString(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  }
  if (value.length > max) throw new JinnMcpToolError(`${name} exceeds ${max} characters`);
  return name === "text" ? value : value.trim();
}

function optionalString(args: Record<string, unknown>, name: string, max: number): string | undefined {
  if (args[name] === undefined || args[name] === null) return undefined;
  return requiredString(args, name, max);
}

function failure(status: number, body: unknown): JinnMcpToolError {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const detail = typeof record.error === "string" ? record.error : JSON.stringify(body);
  if (status === 404) return new JinnMcpToolError("configured connector not found");
  if (status === 400) return new JinnMcpToolError(`connector message rejected: ${detail}`);
  return new JinnMcpToolError(`connector message failed (HTTP ${status}): ${detail}`);
}

export function buildConnectorTools(): JinnMcpTool[] {
  return [{
    name: "send_connector_message",
    description: "Send a message through a configured connector.",
    inputSchema: {
      type: "object",
      properties: {
        connector: { type: "string" },
        channel: { type: "string" },
        text: { type: "string" },
        thread: { type: "string" },
      },
      required: ["connector", "channel", "text"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const connector = requiredString(args, "connector", 64);
      if (!isValidConnectorId(connector)) {
        throw new JinnMcpToolError(`connector ${CONNECTOR_ID_REQUIREMENTS}`);
      }
      const channel = requiredString(args, "channel", 256);
      const text = requiredString(args, "text", 40_000);
      const thread = optionalString(args, "thread", 256);
      const { status, body } = await gatewayRequest(
        ctx,
        "POST",
        `/api/connectors/${encodeURIComponent(connector)}/send`,
        { channel, text, ...(thread ? { thread } : {}) },
      );
      if (status >= 400) throw failure(status, body);
      return { status: "sent", connector, channel };
    },
  }];
}
