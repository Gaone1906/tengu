import { assertBoundCaller, gatewayRequest, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import type { JinnMcpContext } from "./toolkit.js";
import { parseTodoId } from "../work-items/id.js";

export const WORK_ITEM_SEARCH_LIMIT_MAX = 20;
export const WORK_ITEM_SEARCH_LIMIT_DEFAULT = 10;
export const WORK_ITEM_QUERY_CHAR_CAP = 512;
const FILTER_CHAR_CAP = 256;

const STATUSES = ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"] as const;
const SOURCES = ["human", "delegation", "cron", "workflow", "session", "connector", "goal"] as const;
const AGENT_UPDATE_STATUSES = ["executing", "in_review", "blocked", "escalated", "done"] as const;
const VERIFY_MODES = ["trust", "verify", "thorough"] as const;
const ACTIVITY_RECEIPT_HINT = "Preview or Open the persisted activity receipt in this chat.";
const TODO_ID_SCHEMA = { type: "string", pattern: "^JIN-[1-9][0-9]*$" } as const;

function mutationResult(body: unknown, hint: string): Record<string, unknown> {
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : { result: body };
  return { ...value, hint: `${hint} ${ACTIVITY_RECEIPT_HINT}` };
}

function assertIdentity(ctx: JinnMcpContext): void {
  assertBoundCaller(ctx);
}

function assertLength(name: string, value: string, max: number): void {
  if (value.length > max) {
    throw new JinnMcpToolError(`${name} is too long (${value.length} chars, max ${max}) — shorten it and try again`);
  }
}

function requireString(args: Record<string, unknown>, name: string, max = FILTER_CHAR_CAP): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  assertLength(name, s, max);
  return s;
}

function requireTodoId(args: Record<string, unknown>): string {
  try {
    return parseTodoId(args.id);
  } catch {
    throw new JinnMcpToolError("id must be a canonical Todo ID such as JIN-42");
  }
}

function optionalString(args: Record<string, unknown>, name: string, max = FILTER_CHAR_CAP): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new JinnMcpToolError(`${name} must be a non-empty string when provided`);
  const s = v.trim();
  assertLength(name, s, max);
  return s;
}

function optionalEnum<T extends readonly string[]>(args: Record<string, unknown>, name: string, values: T): T[number] | undefined {
  const s = optionalString(args, name);
  if (s === undefined) return undefined;
  if (!(values as readonly string[]).includes(s)) {
    throw new JinnMcpToolError(`${name} must be one of ${values.join(", ")}, got "${s}"`);
  }
  return s as T[number];
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function asText(body: unknown, max = 1200): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
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

function summarize(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    assignee: item.assignee ?? null,
    department: item.department ?? null,
    source: item.source,
    version: item.version,
    updatedAt: item.updatedAt ?? null,
  };
}

function workItemsFrom(body: unknown): Array<Record<string, unknown>> {
  const rec = (body ?? {}) as { workItems?: Array<Record<string, unknown>> };
  return Array.isArray(rec.workItems) ? rec.workItems.map(summarize) : [];
}

function findApprovalKeysDeep(value: unknown, path = "args", found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (/^approval/i.test(key)) found.push(childPath);
    findApprovalKeysDeep(child, childPath, found);
  }
  return found;
}

function rejectApprovalFields(args: Record<string, unknown>, toolName: string): void {
  const forbidden = findApprovalKeysDeep(args);
  if (forbidden.length > 0) {
    throw new JinnMcpToolError(
      `approval fields (${forbidden.join(", ")}) cannot be attached by ${toolName} — approvals are routed gates; request/decide them through the separate approval authority surface, not Todo creation/status updates.`,
    );
  }
}

function optionalObject(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new JinnMcpToolError(`${name} must be a JSON object when provided`);
  return v as Record<string, unknown>;
}

function validateVerifyPolicy(policy: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(["mode", "verifier", "maxRounds"]);
  const extras = Object.keys(policy).filter((key) => !allowed.has(key));
  if (extras.length > 0) throw new JinnMcpToolError(`verifyPolicy has unknown key(s) ${extras.join(", ")}; only mode, verifier, and maxRounds are allowed`);
  if (!(VERIFY_MODES as readonly unknown[]).includes(policy.mode)) {
    throw new JinnMcpToolError(`verifyPolicy.mode must be one of ${VERIFY_MODES.join(", ")}`);
  }
  if (policy.maxRounds !== undefined && (typeof policy.maxRounds !== "number" || !Number.isInteger(policy.maxRounds) || policy.maxRounds < 1 || policy.maxRounds > 20)) {
    throw new JinnMcpToolError("verifyPolicy.maxRounds must be an integer from 1 to 20");
  }
  if (policy.verifier !== undefined) {
    if (!policy.verifier || typeof policy.verifier !== "object" || Array.isArray(policy.verifier)) {
      throw new JinnMcpToolError("verifyPolicy.verifier must be a JSON object when provided");
    }
    const verifier = policy.verifier as Record<string, unknown>;
    const verifierAllowed = new Set(["employee", "engine", "model"]);
    const verifierExtras = Object.keys(verifier).filter((key) => !verifierAllowed.has(key));
    if (verifierExtras.length > 0) {
      throw new JinnMcpToolError(`verifyPolicy.verifier has unknown key(s) ${verifierExtras.join(", ")}; only employee, engine, and model are allowed`);
    }
    for (const key of ["employee", "engine", "model"]) {
      if (verifier[key] !== undefined && (typeof verifier[key] !== "string" || !verifier[key].trim())) {
        throw new JinnMcpToolError(`verifyPolicy.verifier.${key} must be a non-empty string`);
      }
    }
  }
  return policy;
}

function rejectProvenance(args: Record<string, unknown>): void {
  if (args.provenance !== undefined) {
    throw new JinnMcpToolError(
      "provenance cannot be supplied by create_work_item — the server assigns source provenance: create_work_item uses source=session, while cron and delegation create their own records; source=workflow is historical audit provenance and is not currently minted",
    );
  }
}

export function buildWorkItemTools(): JinnMcpTool[] {
  const list: JinnMcpTool = {
    name: "list_work_items",
    description: "List recent or filtered Todos as compact summaries.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES] },
        source: { type: "string", enum: [...SOURCES] },
        assignee: { type: "string" },
        department: { type: "string" },
        needsAttentionFor: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const params = qs({
        status: optionalEnum(args, "status", STATUSES),
        source: optionalEnum(args, "source", SOURCES),
        assignee: optionalString(args, "assignee"),
        department: optionalString(args, "department"),
        needsAttentionFor: optionalString(args, "needsAttentionFor"),
        limit: clampInt(args.limit, WORK_ITEM_SEARCH_LIMIT_DEFAULT, 1, WORK_ITEM_SEARCH_LIMIT_MAX),
      });
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items?${params}`);
      if (status >= 400) throw gatewayFailure("listing work items", status, body);
      const workItems = workItemsFrom(body);
      return { workItems, hint: workItems.length ? "Next: get_work_item { id }." : "No matches. Next: search_work_items or create_work_item." };
    },
  };

  const get: JinnMcpTool = {
    name: "get_work_item",
    description: "Get one Todo full detail.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}`);
      if (status >= 400) throw gatewayFailure(`getting work item "${id}"`, status, body);
      return body;
    },
  };

  const search: JinnMcpTool = {
    name: "search_work_items",
    description: "Search Todos by text and structured filters; compact hits only.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        status: { type: "string", enum: [...STATUSES] },
        source: { type: "string", enum: [...SOURCES] },
        assignee: { type: "string" },
        department: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const params: Record<string, string | number | undefined> = {
        text: optionalString(args, "text", WORK_ITEM_QUERY_CHAR_CAP),
        status: optionalEnum(args, "status", STATUSES),
        source: optionalEnum(args, "source", SOURCES),
        assignee: optionalString(args, "assignee"),
        department: optionalString(args, "department"),
        limit: clampInt(args.limit, WORK_ITEM_SEARCH_LIMIT_DEFAULT, 1, WORK_ITEM_SEARCH_LIMIT_MAX),
      };
      const hasFilter = Object.entries(params).some(([k, v]) => k !== "limit" && v !== undefined);
      if (!hasFilter) throw new JinnMcpToolError("pass at least one filter (text, status, source, assignee, department) — for recent Todos use list_work_items.");
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/search/work-items?${qs(params)}`);
      if (status >= 400) throw gatewayFailure("searching work items", status, body);
      const workItems = workItemsFrom(body);
      return { workItems, hint: workItems.length ? "Next: get_work_item { id }." : "No matches. Try fewer words or filters." };
    },
  };

  const create: JinnMcpTool = {
    name: "create_work_item",
    description: "Create a Todo; approvals excluded.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        acceptance: { type: "string" },
        assignee: { type: "string" },
        department: { type: "string" },
        verifyPolicy: { type: "object" },
      },
      required: ["title"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "create_work_item");
      rejectProvenance(args);
      const body: Record<string, unknown> = { title: requireString(args, "title") };
      for (const key of ["body", "acceptance", "assignee", "department"] as const) {
        const v = optionalString(args, key, key === "body" || key === "acceptance" ? 20_000 : FILTER_CHAR_CAP);
        if (v !== undefined) body[key] = v;
      }
      const verifyPolicy = optionalObject(args, "verifyPolicy");
      if (verifyPolicy) body.verifyPolicy = validateVerifyPolicy(verifyPolicy);
      const { status, body: resp } = await gatewayRequest(ctx, "POST", "/api/work-items", body);
      if (status >= 400) throw gatewayFailure("creating work item", status, resp);
      return mutationResult(resp, "Next: assign_work_item or update_work_item.");
    },
  };

  const update: JinnMcpTool = {
    name: "update_work_item",
    description: "Update Todo status.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        status: { type: "string", enum: [...AGENT_UPDATE_STATUSES] },
        note: { type: "string" },
      },
      required: ["id", "status"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "update_work_item");
      const id = requireTodoId(args);
      const rawStatus = requireString(args, "status");
      if (rawStatus === "cancelled") {
        throw new JinnMcpToolError("cancelling a Todo is a human surface decision; agents do not have a cancel tool.");
      }
      if (!(AGENT_UPDATE_STATUSES as readonly string[]).includes(rawStatus)) {
        throw new JinnMcpToolError(`status must be one of ${AGENT_UPDATE_STATUSES.join(", ")}; cancellation/other lifecycle edits are human surface decisions.`);
      }
      const payload: Record<string, unknown> = { status: rawStatus };
      const note = optionalString(args, "note", 4000);
      if (note !== undefined) payload.note = note;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/status`, payload);
      if (status >= 400) throw gatewayFailure(`updating work item "${id}"`, status, body);
      return mutationResult(body, "Todo status updated.");
    },
  };

  const assign: JinnMcpTool = {
    name: "assign_work_item",
    description: "Assign a Todo.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        assignee: { type: "string" },
      },
      required: ["id", "assignee"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "assign_work_item");
      const id = requireTodoId(args);
      const assignee = requireString(args, "assignee");
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/assign`, { assignee });
      if (status >= 400) throw gatewayFailure(`assigning work item "${id}"`, status, body);
      return mutationResult(body, "Todo assigned.");
    },
  };

  const archive: JinnMcpTool = {
    name: "archive_work_item",
    description: "Archive a Todo; retain its audit.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        note: { type: "string" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "archive_work_item");
      const id = requireTodoId(args);
      const payload: Record<string, unknown> = {};
      const note = optionalString(args, "note", 4000);
      if (note !== undefined) payload.note = note;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/archive`, payload);
      if (status >= 400) throw gatewayFailure(`archiving work item "${id}"`, status, body);
      return mutationResult(body, "Todo archived.");
    },
  };

  return [list, get, search, create, update, assign, archive];
}
