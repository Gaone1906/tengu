import { assertBoundCaller, gatewayRequest, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import type { JinnMcpContext } from "./toolkit.js";

export const WORK_ITEM_SEARCH_LIMIT_MAX = 20;
export const WORK_ITEM_SEARCH_LIMIT_DEFAULT = 10;
export const WORK_ITEM_QUERY_CHAR_CAP = 512;
const FILTER_CHAR_CAP = 256;

const STATUSES = ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"] as const;
const SOURCES = ["human", "delegation", "cron", "workflow", "session", "connector", "goal"] as const;
const AGENT_UPDATE_STATUSES = ["in_review", "blocked", "escalated", "done"] as const;
const VERIFY_MODES = ["trust", "verify", "thorough"] as const;

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
      "provenance cannot be supplied by create_work_item — cron/workflow/delegation source records are minted only by their dedicated bridge; normal tool/session creation is source=session",
    );
  }
}

export function buildWorkItemTools(): JinnMcpTool[] {
  const list: JinnMcpTool = {
    name: "list_work_items",
    description:
      "List recent or structured-filtered Todos (substrate: work_items) by status/source/assignee/department, or pass needsAttentionFor='me' for your own approval/blocked queue. Read-only, compact summaries only. Use get_work_item for full acceptance, approval, spend, rounds, and workflow-run detail.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES], description: "Todo status." },
        source: { type: "string", enum: [...SOURCES], description: "Provenance source." },
        assignee: { type: "string", description: "Exact employee slug assigned to the Todo." },
        department: { type: "string", description: "Exact department slug." },
        needsAttentionFor: { type: "string", description: "Use 'me' to list the capability-scoped queue needing your attention." },
        limit: { type: "number", description: `Max results (1-${WORK_ITEM_SEARCH_LIMIT_MAX}, default ${WORK_ITEM_SEARCH_LIMIT_DEFAULT}).` },
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
      return { workItems, hint: workItems.length ? "Read full detail with get_work_item { id }." : "No matching Todos. Search text with search_work_items or create one with create_work_item." };
    },
  };

  const get: JinnMcpTool = {
    name: "get_work_item",
    description:
      "Get one Todo's full detail: body, acceptance, verify policy, rounds, approval fields, live spend, workflowRun reference, and event log. Read-only.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Work item id, e.g. wi_abc123." } },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireString(args, "id");
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}`);
      if (status >= 400) throw gatewayFailure(`getting work item "${id}"`, status, body);
      return body;
    },
  };

  const search: JinnMcpTool = {
    name: "search_work_items",
    description:
      "Text search Todos with deterministic escaped-LIKE text over title+body AND-composed with status/source/assignee/department filters. Operators like %, _, and backslash are literal. Returns <=20 compact hits, never body dumps.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: `Literal substring over title + body (max ${WORK_ITEM_QUERY_CHAR_CAP} chars).` },
        status: { type: "string", enum: [...STATUSES], description: "Todo status." },
        source: { type: "string", enum: [...SOURCES], description: "Provenance source." },
        assignee: { type: "string", description: "Exact assignee slug." },
        department: { type: "string", description: "Exact department slug." },
        limit: { type: "number", description: `Max hits (1-${WORK_ITEM_SEARCH_LIMIT_MAX}, default ${WORK_ITEM_SEARCH_LIMIT_DEFAULT}).` },
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
      return { workItems, hint: workItems.length ? "Read full detail with get_work_item { id }." : "No matching Todos. Try fewer words or drop a structured filter." };
    },
  };

  const create: JinnMcpTool = {
    name: "create_work_item",
    description:
      "Create a Todo for COO decomposition or agent-captured work. Agent-legal live write. Approval is deliberately impossible here: fresh Todos never attach approvals; approval decisions use the separate routed authority tools.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short Todo title." },
        body: { type: "string", description: "Brief/spec body." },
        acceptance: { type: "string", description: "Acceptance criteria/checklist." },
        assignee: { type: "string", description: "Optional assignee slug; use assign_work_item for roster-validated assignment." },
        department: { type: "string", description: "Optional department slug." },
        verifyPolicy: { type: "object", description: "{ mode: 'trust'|'verify'|'thorough', maxRounds? }." },
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
      return { ...(resp as Record<string, unknown>), hint: "Todo created. Assign with assign_work_item or keep it current with update_work_item." };
    },
  };

  const update: JinnMcpTool = {
    name: "update_work_item",
    description:
      "Update your Todo status through the guarded transition rules. Agent-legal statuses: in_review, blocked, escalated, done. Own executing item -> done is refused by the self-review ban; cancellation and approval decisions are human-surface only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Work item id." },
        status: { type: "string", enum: [...AGENT_UPDATE_STATUSES], description: "Target status. No cancelled here: cancellation is a human surface." },
        note: { type: "string", description: "Reason/status note, required for blocked/escalated in practice." },
      },
      required: ["id", "status"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "update_work_item");
      const id = requireString(args, "id");
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
      return body;
    },
  };

  const assign: JinnMcpTool = {
    name: "assign_work_item",
    description:
      "Assign a Todo to a named employee. Agent-legal collaborative write; the gateway validates the employee against the org roster and returns near-match hints on typos.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Work item id." },
        assignee: { type: "string", description: "Employee slug from find_employees / list_employees." },
      },
      required: ["id", "assignee"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "assign_work_item");
      const id = requireString(args, "id");
      const assignee = requireString(args, "assignee");
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/assign`, { assignee });
      if (status >= 400) throw gatewayFailure(`assigning work item "${id}"`, status, body);
      return body;
    },
  };

  const archive: JinnMcpTool = {
    name: "archive_work_item",
    description:
      "Archive a Todo without deleting it. This moves the item to the closed/archived status used by the ledger, preserves the row and audit trail, and records an optional note.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Work item id." },
        note: { type: "string", description: "Optional reason for archiving." },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "archive_work_item");
      const id = requireString(args, "id");
      const payload: Record<string, unknown> = {};
      const note = optionalString(args, "note", 4000);
      if (note !== undefined) payload.note = note;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/archive`, payload);
      if (status >= 400) throw gatewayFailure(`archiving work item "${id}"`, status, body);
      return body;
    },
  };

  return [list, get, search, create, update, assign, archive];
}
