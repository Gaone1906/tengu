import { assertBoundCaller, gatewayRequest, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";

/**
 * GRS-017a — the SESSIONS tool group of the `jinn` MCP server: agents spawn,
 * read, message, list, and stop sessions through typed tools instead of curl.
 * This is the operator's headline for the MCP company surface: agents
 * communicate via MCP, not raw HTTP.
 *
 * Contract (012d-0 admission rules, unchanged): every tool is a thin
 * DETERMINISTIC wrapper over ONE existing gateway session route; outputs are
 * decision-shaped (record fields + a `hint` naming the next step); structured
 * gateway errors pass through readable so the agent self-corrects.
 *
 * Domain-specific rules this module owns:
 *   - SESSION READING: `last` is a non-negative integer, where 0 requests the
 *     whole transcript. Message bodies are returned as stored.
 *   - PROTOCOL TEACHING lives in exactly two places (schema-budget rule "one
 *     teaching description per domain"): the spawn tool's description/hint
 *     carries the end-turn-and-await-callback protocol; everything else stays
 *     one-line.
 *   - IDENTITY: ctx.callerSessionId (the JINN_SESSION_ID env) rides every call
 *     as `x-jinn-caller-session` via the toolkit. The GATEWAY enforces the
 *     guards (no-self, rate cap, hop budget, own-descendant stop) so curl is
 *     equally guarded; tools only pre-check what saves a pointless round trip.
 *   - FAIL CLOSED ON LOST IDENTITY (codex finding 2): spawn/send/stop always
 *     act on behalf of a session, so when this server has NO caller identity
 *     (an engine stripped JINN_SESSION_ID) they refuse locally — and the
 *     routes refuse the marker-tagged request too — instead of falling through
 *     to the gateway's unrestricted operator paths. Reads stay available.
 *   - DELIBERATELY ABSENT: a delete tool. Deleting a session destroys the
 *     durable record (messages, links, evidence). That is the session-domain
 *     twin of gate-resolve: it needs HUMAN actor authority, which no
 *     environment gate or self-declared header can substitute (GRS-015
 *     lesson). Deletion stays on the HTTP route / web UI for the operator.
 */

/* ── Limits (design §1.2) ───────────────────────────────────────────────────── */

/** Default messages per read when `last` is omitted. */
export const READ_LAST_DEFAULT = 30;
/** Max sessions per list call. */
export const LIST_LIMIT_MAX = 50;
/** Default sessions per list call. */
export const LIST_LIMIT_DEFAULT = 20;

/* ── Small deterministic helpers ────────────────────────────────────────────── */

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  return s;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new JinnMcpToolError(`${name} must be a non-empty string when provided`);
  return v.trim();
}

/** Fail-closed identity gate for the scoped write tools (spawn/send/stop): a
 *  server with no caller identity refuses before any round trip. The route
 *  applies the same rule via the tool-origin marker, as the substrate backstop. */
function requireCallerIdentity(ctx: JinnMcpContext): string {
  assertBoundCaller(ctx);
  return ctx.callerSessionId;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function readLast(value: unknown): number {
  if (value === undefined || value === null) return READ_LAST_DEFAULT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new JinnMcpToolError("last must be a non-negative integer (0 requests the whole transcript)");
  }
  return value;
}

function asText(body: unknown, max = 2000): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Non-2xx gateway response → a decision-shaped tool error for this domain. */
function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 404) {
    return new JinnMcpToolError(`${what} failed (404): session not found. Use list_sessions to discover valid session ids.`);
  }
  if (status === 429) {
    return new JinnMcpToolError(`${what} refused (429): ${detail}`);
  }
  if (status === 403) {
    return new JinnMcpToolError(`${what} refused (403): ${detail}`);
  }
  if (status === 400) {
    return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  }
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

const sessionPath = (id: string): string => `/api/sessions/${encodeURIComponent(id)}`;

/** The summary shape list/read expose — never message bodies in lists. */
interface SessionRecord {
  id?: string;
  title?: string | null;
  employee?: string | null;
  engine?: string;
  model?: string | null;
  status?: string;
  lastActivity?: string | null;
  lastError?: string | null;
  parentSessionId?: string | null;
  messages?: Array<{ role?: string; content?: string; timestamp?: number }>;
}

function summarize(s: SessionRecord): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title ?? null,
    employee: s.employee ?? null,
    engine: s.engine,
    status: s.status,
    lastActivity: s.lastActivity ?? null,
    parentSessionId: s.parentSessionId ?? null,
  };
}

/** Deterministic next-step hint from a session's status alone. */
function statusHint(s: SessionRecord): string {
  switch (s.status) {
    case "running":
      return "Running: END YOUR TURN; reply wakes you. Next: read_session; never poll.";
    case "idle":
      return "Idle: latest reply shown. Next: send_to_session.";
    case "error":
      return s.lastError
        ? `Error: ${asText(s.lastError, 32)}. Next: send_to_session or report.`
        : "Error. Next: send_to_session or report.";
    case "waiting":
      return "Waiting on limit. Next: no action.";
    case "interrupted":
      return "Interrupted. Next: send_to_session.";
    default:
      return "Next: read_session or send_to_session.";
  }
}

/* ── The tool group ─────────────────────────────────────────────────────────── */

export function buildSessionTools(): JinnMcpTool[] {
  const spawnSession: JinnMcpTool = {
    name: "spawn_session",
    description:
      "Spawn quick untracked session. For tracked company work use delegate_task. END YOUR TURN; never poll. Reuse employees for parallel sessions.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        employee: {
          type: "string",
          description:
            "Employee slug; choose by role/persona fit from list_employees/find_employees. Omit for a plain session or if no employee fits.",
        },
        engine: { type: "string" },
        model: { type: "string" },
        effortLevel: { type: "string" },
      },
      required: ["prompt"],
    },
    handler: async (args, ctx) => {
      requireCallerIdentity(ctx);
      const prompt = requireString(args, "prompt");
      const body: Record<string, unknown> = { prompt };
      for (const key of ["employee", "engine", "model", "effortLevel"] as const) {
        const v = optionalString(args, key);
        if (v !== undefined) body[key] = v;
      }
      const { status, body: resp } = await gatewayRequest(ctx, "POST", "/api/sessions", body);
      if (status >= 400) throw gatewayFailure("spawning the session", status, resp);
      const s = (resp ?? {}) as SessionRecord;
      return {
        sessionId: s.id,
        employee: s.employee ?? null,
        engine: s.engine,
        model: s.model ?? null,
        status: s.status,
        hint: "Session linked to you as a child. END YOUR TURN; reply wakes you. Next: read_session; never poll.",
      };
    },
  };

  const sendToSession: JinnMcpTool = {
    name: "send_to_session",
    description: "Send a follow-up message to another session; gateway guards apply.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        message: { type: "string" },
      },
      required: ["sessionId", "message"],
    },
    handler: async (args, ctx) => {
      const callerId = requireCallerIdentity(ctx);
      const sessionId = requireString(args, "sessionId");
      const message = requireString(args, "message");
      if (callerId === sessionId) {
        // Same refusal the gateway gives; checked here to save the round trip.
        throw new JinnMcpToolError("cannot message your own session — write your conclusion in your reply instead.");
      }
      const { status, body } = await gatewayRequest(ctx, "POST", `${sessionPath(sessionId)}/message`, { message });
      if (status >= 400) throw gatewayFailure(`messaging session "${sessionId}"`, status, body);
      return {
        status: "queued",
        sessionId,
        hint: "Queued. Next: END YOUR TURN for reply or read_session.",
      };
    },
  };

  const readSession: JinnMcpTool = {
    name: "read_session",
    description: "Read one session status and messages in full; last=0 returns the whole transcript.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        last: {
          type: "number",
          description: `Recent messages; 0=all (default ${READ_LAST_DEFAULT}).`,
        },
      },
      required: ["sessionId"],
    },
    handler: async (args, ctx) => {
      requireCallerIdentity(ctx);
      const sessionId = requireString(args, "sessionId");
      const last = readLast(args.last);
      const { status, body } = await gatewayRequest(ctx, "GET", `${sessionPath(sessionId)}?last=${last}`);
      if (status >= 400) throw gatewayFailure(`reading session "${sessionId}"`, status, body);
      const s = (body ?? {}) as SessionRecord;
      const messages = (Array.isArray(s.messages) ? s.messages : []).map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : "",
        timestamp: m.timestamp,
      }));
      return {
        ...summarize(s),
        model: s.model ?? null,
        lastError: s.lastError ?? null,
        messages,
        hint: statusHint(s),
      };
    },
  };

  const listSessions: JinnMcpTool = {
    name: "list_sessions",
    description: "List capped session summaries by children, employee, or recent scope.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["children", "employee", "recent"], description: "Which sessions (default children)." },
        employee: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      requireCallerIdentity(ctx);
      const scope = optionalString(args, "scope") ?? "children";
      const limit = clampInt(args.limit, LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
      let sessions: SessionRecord[];
      if (scope === "children") {
        if (!ctx.callerSessionId) {
          throw new JinnMcpToolError(
            "scope 'children' needs a caller identity, and this server has none (not launched by a Jinn session). Use scope 'recent' or 'employee'.",
          );
        }
        const { status, body } = await gatewayRequest(ctx, "GET", `${sessionPath(ctx.callerSessionId)}/children`);
        if (status >= 400) throw gatewayFailure("listing child sessions", status, body);
        sessions = (Array.isArray(body) ? body : []) as SessionRecord[];
      } else if (scope === "employee") {
        const employee = optionalString(args, "employee");
        if (!employee) throw new JinnMcpToolError("employee is required when scope is 'employee'");
        const { status, body } = await gatewayRequest(
          ctx,
          "GET",
          `/api/sessions?group=${encodeURIComponent(employee)}&limit=${limit}`,
        );
        if (status >= 400) throw gatewayFailure(`listing sessions of "${employee}"`, status, body);
        sessions = (Array.isArray(body) ? body : []) as SessionRecord[];
      } else if (scope === "recent") {
        const { status, body } = await gatewayRequest(ctx, "GET", "/api/sessions");
        if (status >= 400) throw gatewayFailure("listing recent sessions", status, body);
        const rec = (body ?? {}) as { sessions?: SessionRecord[] };
        sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
      } else {
        throw new JinnMcpToolError(`unknown scope "${scope}" — use children, employee, or recent`);
      }
      return {
        scope,
        sessions: sessions.slice(0, limit).map(summarize),
        hint: "Next: read_session or send_to_session.",
      };
    },
  };

  const stopSession: JinnMcpTool = {
    name: "stop_session",
    description: "Stop a running descendant session without deleting its record.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
    handler: async (args, ctx) => {
      requireCallerIdentity(ctx);
      const sessionId = requireString(args, "sessionId");
      const { status, body } = await gatewayRequest(ctx, "POST", `${sessionPath(sessionId)}/stop`, {});
      if (status >= 400) throw gatewayFailure(`stopping session "${sessionId}"`, status, body);
      // GRS-017f: report an ACTION RESULT, not a session-state field. Stop is
      // recoverable-by-design (the record + messages survive, a follow-up
      // resumes it), so the session's persistent status is `idle` — read_session
      // correctly shows `idle`. A `status: "stopped"` return masqueraded
      // as that state field and contradicted read; `action: "stopped"` reads as
      // "the stop succeeded" without inventing a fake persistent 'stopped' state.
      return {
        action: "stopped",
        sessionId,
        hint: "Stopped, recoverable. Next: read_session or send_to_session.",
      };
    },
  };

  return [spawnSession, sendToSession, readSession, listSessions, stopSession];
}
