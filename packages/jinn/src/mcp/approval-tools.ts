import { UNIDENTIFIED_TOOL_CALL_ERROR } from "./identity.js";
import { gatewayRequest, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";

const DECISIONS = ["approve", "reject"] as const;
const ACTIVITY_RECEIPT_HINT = "Preview or Open the persisted activity receipt in this chat.";

function mutationResult(body: unknown, hint: string): Record<string, unknown> {
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : { result: body };
  return { ...value, hint: `${hint} ${ACTIVITY_RECEIPT_HINT}` };
}

function assertIdentity(ctx: JinnMcpContext): void {
  if (!ctx.callerSessionId) throw new JinnMcpToolError(UNIDENTIFIED_TOOL_CALL_ERROR);
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  return text;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new JinnMcpToolError(`${name} must be a non-empty string when provided`);
  return value.trim();
}

function asText(body: unknown, max = 1200): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  if (status === 403) return new JinnMcpToolError(`${what} refused (403): ${detail}`);
  if (status === 404) return new JinnMcpToolError(`${what} failed (404): ${detail || "not found"}`);
  if (status === 409) return new JinnMcpToolError(`${what} conflicted (409): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

export function buildApprovalTools(): JinnMcpTool[] {
  const request: JinnMcpTool = {
    name: "request_work_item_approval",
    description: "Request Todo approval.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        request: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        target: { type: "string" },
        operatorOnly: { type: "boolean" },
      },
      required: ["id", "request"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireString(args, "id");
      const payload: Record<string, unknown> = { request: requireString(args, "request") };
      const options = args.options;
      if (options !== undefined) {
        if (!Array.isArray(options) || options.some((option) => typeof option !== "string")) {
          throw new JinnMcpToolError("options must be an array of strings");
        }
        payload.options = options;
      }
      const target = optionalString(args, "target");
      if (target !== undefined) payload.target = target;
      const operatorOnly = args.operatorOnly;
      if (operatorOnly !== undefined) {
        if (typeof operatorOnly !== "boolean") throw new JinnMcpToolError("operatorOnly must be a boolean");
        payload.operatorOnly = operatorOnly;
      }
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/approval/request`, payload);
      if (status >= 400) throw gatewayFailure(`requesting approval for work item "${id}"`, status, body);
      return mutationResult(body, "Approval requested.");
    },
  };

  const decide: JinnMcpTool = {
    name: "decide_work_item_approval",
    description: "Decide Todo approval.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        decision: { type: "string", enum: [...DECISIONS] },
        choice: { type: "string" },
        note: { type: "string" },
      },
      required: ["id", "decision"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireString(args, "id");
      const decision = requireString(args, "decision");
      if (!(DECISIONS as readonly string[]).includes(decision)) {
        throw new JinnMcpToolError(`decision must be one of ${DECISIONS.join(", ")}`);
      }
      const payload: Record<string, unknown> = { decision };
      const choice = optionalString(args, "choice");
      if (choice !== undefined) payload.choice = choice;
      const note = optionalString(args, "note");
      if (note !== undefined) payload.note = note;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/approval`, payload);
      if (status >= 400) throw gatewayFailure(`deciding approval for work item "${id}"`, status, body);
      return mutationResult(body, "Approval decided.");
    },
  };

  const escalate: JinnMcpTool = {
    name: "escalate_work_item_approval",
    description: "Escalate Todo approval.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireString(args, "id");
      const payload: Record<string, unknown> = {};
      const reason = optionalString(args, "reason");
      if (reason !== undefined) payload.reason = reason;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/approval/escalate`, payload);
      if (status >= 400) throw gatewayFailure(`escalating approval for work item "${id}"`, status, body);
      return mutationResult(body, "Approval escalated.");
    },
  };

  return [request, decide, escalate];
}
