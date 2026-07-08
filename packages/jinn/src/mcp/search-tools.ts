import { assertBoundCaller, gatewayGet, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";

/**
 * GRS-020a — the company-REFERENCE tool group of the `jinn` MCP server: agents
 * search messages across all sessions, search sessions by structured filters,
 * and expand a search hit into its surrounding context.
 *
 * Contract (012d-0 admission rules, unchanged): every tool is a thin
 * DETERMINISTIC wrapper over ONE gateway read route; no LLM ranking (message
 * search is recency-first, session search is last-activity-first); outputs are
 * decision-shaped with a `hint` naming the next step.
 *
 * Domain rules this module owns:
 *   - INJECTION SAFETY lives in the STORE, not here: the registry's
 *     sanitizeFtsQuery turns every token into a quoted FTS5 phrase, so MATCH
 *     operators (* NEAR - " OR) are literal text and a syntax error is
 *     structurally impossible. The tools pass the raw query through as a URL
 *     parameter — they never build SQL or MATCH strings.
 *   - CONTEXT-BOMB GUARDS: search returns SNIPPETS only (≤ {@link SNIPPET_CHAR_CAP}
 *     chars each, ≤ {@link SEARCH_LIMIT_MAX} hits); session search returns
 *     summaries without message bodies; get-context is radius-bounded with the
 *     store's 2,000-char per-message cap. There is deliberately NO
 *     full-transcript mode anywhere on the reference layer.
 *   - SELF-EXCLUSION (GRS-020a-fix finding 1): search_messages excludes
 *     the CALLER'S OWN session by default — the act of searching for X is
 *     itself a message containing X, and newest-first ranking would return it
 *     as the top hit. Explicit sessionId scope or includeOwnSession opts back
 *     in. This is a read-tier USE of the identity seam, not an authority gate.
 *   - LENGTH CAPS (finding 3): query/text are capped tool-side (structured
 *     "shorten it" error) BEFORE the HTTP call, so an over-long query can never
 *     surface as a raw HTTP 431. Follow-up if real queries ever need more: move
 *     search to a JSON POST route; the GET+caps shape is the KISS v1.
 *   - READ TIER: these are privileged company reads. Tool-marked or
 *     caller-session-claimed requests must carry a valid bound session
 *     capability; operator/browser reads without those headers remain unchanged.
 *   - TEACHING lives on search_messages (one teaching description per
 *     domain); the other two stay short.
 */

/* ── Caps (design §1) ───────────────────────────────────────────────────────── */

/** Max hits per message search. */
export const SEARCH_LIMIT_MAX = 20;
/** Default hits per message search. */
export const SEARCH_LIMIT_DEFAULT = 10;
/** Defensive per-snippet char cap (the store's snippet() is ~12 tokens already). */
export const SNIPPET_CHAR_CAP = 300;
/** Max session summaries per session search. */
export const SESSION_SEARCH_LIMIT_MAX = 50;
/** Default session summaries per session search. */
export const SESSION_SEARCH_LIMIT_DEFAULT = 20;
/** Max messages each side of a context anchor. */
export const CONTEXT_RADIUS_MAX = 10;
/** Default context radius. */
export const CONTEXT_RADIUS_DEFAULT = 3;
/** Tool-side cap on the search query / text filter (GRS-020a-fix finding 3):
 *  an over-long query must become a STRUCTURED "shorten it" error before the
 *  HTTP call — never a raw 431 from the HTTP parser. Half the route-side cap,
 *  so the tool always fails first with the friendlier message. */
export const QUERY_CHAR_CAP = 512;
/** Tool-side cap on every other string filter (ids/slugs are far shorter). */
export const FILTER_CHAR_CAP = 256;

const SESSION_STATUSES = ["idle", "running", "error", "waiting", "interrupted"] as const;

/* ── Small deterministic helpers (module-local, same pattern as org-tools) ──── */

/** Structured over-length refusal (finding 3) — thrown BEFORE any HTTP call. */
function assertLength(name: string, value: string, max: number): void {
  if (value.length > max) {
    throw new JinnMcpToolError(`${name} is too long (${value.length} chars, max ${max}) — shorten it and search again`);
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

/** ISO-8601 validation happens tool-side too (saves a round trip); the value is
 *  forwarded verbatim — the route re-validates. */
function optionalIso(args: Record<string, unknown>, name: string): string | undefined {
  const v = optionalString(args, name);
  if (v === undefined) return undefined;
  if (Number.isNaN(Date.parse(v))) {
    throw new JinnMcpToolError(`${name} must be an ISO-8601 timestamp (e.g. "2026-07-01T00:00:00Z"), got "${v}"`);
  }
  return v;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function asText(body: unknown, max = 500): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Non-2xx gateway response → a readable tool error (structured bodies pass through). */
function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 404) return new JinnMcpToolError(`${what} failed (404): ${detail}`);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

/** Compact session summary — the same shape list_sessions exposes. */
function summarizeSession(s: Record<string, unknown>): Record<string, unknown> {
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

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

/* ── The tool group ─────────────────────────────────────────────────────────── */

export function buildSearchTools(): JinnMcpTool[] {
  const searchMessages: JinnMcpTool = {
    name: "search_messages",
    description:
      "Full-text search across OTHER sessions' user/assistant messages — the company reference layer: find where something was discussed, decided, or reported, then expand a hit with get_message_context and see the session's current state with read_session. Your OWN session is excluded by default (your search request would otherwise match itself); pass includeOwnSession true to search your own history. Query is plain words (a multi-word query requires ALL words; operators like OR/NEAR/* are treated as literal text). Newest hits first. Returns snippets only, never full messages.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: `Plain words to search for (all must appear; max ${QUERY_CHAR_CAP} chars).` },
        sessionId: { type: "string", description: "Only hits in this session (explicit scope — overrides the own-session exclusion)." },
        includeOwnSession: { type: "boolean", description: "Include your own session's messages (default false — excluded so the search never matches itself)." },
        employee: { type: "string", description: "Only sessions of this employee (exact slug, case-insensitive)." },
        engine: { type: "string", description: "Only sessions on this engine (e.g. claude, codex)." },
        role: { type: "string", enum: ["user", "assistant"], description: "Only messages with this role." },
        since: { type: "string", description: "Only messages at/after this ISO-8601 time." },
        until: { type: "string", description: "Only messages at/before this ISO-8601 time." },
        limit: { type: "number", description: `Max hits (1–${SEARCH_LIMIT_MAX}, default ${SEARCH_LIMIT_DEFAULT}).` },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const query = requireString(args, "query", QUERY_CHAR_CAP);
      const role = optionalString(args, "role");
      if (role !== undefined && role !== "user" && role !== "assistant") {
        throw new JinnMcpToolError(`role must be "user" or "assistant" (only those rows are indexed), got "${role}"`);
      }
      const limit = clampInt(args.limit, SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX);
      const sessionId = optionalString(args, "sessionId");
      // GRS-020a-fix finding 1: the caller's own act of searching for X is a
      // user message containing X — newest-first ranking would return it as the
      // top hit. Exclude the caller's session unless the caller explicitly
      // scoped to a session or opted in. Read-tier identity USE, not a gate:
      // no identity (operator-launched server) simply means nothing to exclude.
      const excludeOwn = !sessionId && args.includeOwnSession !== true && ctx.callerSessionId ? ctx.callerSessionId : undefined;
      const query_ = qs({
        q: query,
        sessionId,
        excludeSessionId: excludeOwn,
        employee: optionalString(args, "employee"),
        engine: optionalString(args, "engine"),
        role,
        since: optionalIso(args, "since"),
        until: optionalIso(args, "until"),
        limit,
      });
      const { status, body } = await gatewayGet(ctx, `/api/search/messages?${query_}`);
      if (status >= 400) throw gatewayFailure("searching messages", status, body);
      const rec = (body ?? {}) as { results?: Array<Record<string, unknown>> };
      const results = (Array.isArray(rec.results) ? rec.results : []).map((r) => ({
        messageId: r.messageId,
        sessionId: r.sessionId,
        role: r.role,
        timestamp: r.timestamp,
        employee: r.employee ?? null,
        engine: r.engine ?? null,
        snippet: typeof r.snippet === "string" && r.snippet.length > SNIPPET_CHAR_CAP ? `${r.snippet.slice(0, SNIPPET_CHAR_CAP)}…` : r.snippet,
      }));
      return {
        query,
        results,
        hint:
          results.length === 0
            ? `No hits. Try fewer/different words (all words must appear), widen the time range, or drop a filter.${excludeOwn ? " Your own session was excluded (default) — pass includeOwnSession true to search it." : ""}`
            : "Read around a hit with get_message_context { sessionId, messageId }; check the session's current state with read_session.",
      };
    },
  };

  const searchSessions: JinnMcpTool = {
    name: "search_sessions",
    description:
      "Find sessions by AND-composed filters: text (matches title/prompt-excerpt/id as a literal substring), employee, engine, status, source, parentSessionId, activeSince/activeBefore (ISO-8601), needsAttention (status error|interrupted). At least one filter required. Returns capped summaries newest-first — no message bodies.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Literal substring over title, prompt excerpt, and id." },
        employee: { type: "string", description: "Exact employee slug (case-insensitive)." },
        engine: { type: "string", description: "Exact engine (case-insensitive)." },
        status: { type: "string", enum: [...SESSION_STATUSES], description: "Exact status." },
        source: { type: "string", description: "Exact source (e.g. web, cron, slack)." },
        parentSessionId: { type: "string", description: "Only children of this session." },
        activeSince: { type: "string", description: "Only sessions active at/after this ISO-8601 time." },
        activeBefore: { type: "string", description: "Only sessions active at/before this ISO-8601 time." },
        needsAttention: { type: "boolean", description: "Only sessions in status error or interrupted." },
        limit: { type: "number", description: `Max results (1–${SESSION_SEARCH_LIMIT_MAX}, default ${SESSION_SEARCH_LIMIT_DEFAULT}).` },
      },
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const status_ = optionalString(args, "status");
      if (status_ !== undefined && !(SESSION_STATUSES as readonly string[]).includes(status_)) {
        throw new JinnMcpToolError(`status must be one of ${SESSION_STATUSES.join(", ")}, got "${status_}"`);
      }
      const needsAttention = args.needsAttention === true;
      const params: Record<string, string | number | undefined> = {
        text: optionalString(args, "text", QUERY_CHAR_CAP),
        employee: optionalString(args, "employee"),
        engine: optionalString(args, "engine"),
        status: status_,
        source: optionalString(args, "source"),
        parentSessionId: optionalString(args, "parentSessionId"),
        activeSince: optionalIso(args, "activeSince"),
        activeBefore: optionalIso(args, "activeBefore"),
      };
      if (needsAttention) params.needsAttention = "true";
      const hasFilter = Object.values(params).some((v) => v !== undefined);
      if (!hasFilter) {
        throw new JinnMcpToolError(
          "pass at least one filter (text, employee, engine, status, source, parentSessionId, activeSince, activeBefore, needsAttention) — for your children or recent sessions use list_sessions.",
        );
      }
      params.limit = clampInt(args.limit, SESSION_SEARCH_LIMIT_DEFAULT, 1, SESSION_SEARCH_LIMIT_MAX);
      const { status, body } = await gatewayGet(ctx, `/api/search/sessions?${qs(params)}`);
      if (status >= 400) throw gatewayFailure("searching sessions", status, body);
      const rec = (body ?? {}) as { sessions?: Array<Record<string, unknown>> };
      const sessions = (Array.isArray(rec.sessions) ? rec.sessions : []).map(summarizeSession);
      return {
        sessions,
        hint:
          sessions.length === 0
            ? `No sessions match. Valid statuses: ${SESSION_STATUSES.join(", ")}. Check employee slugs with find_employees, or search message CONTENT with search_messages.`
            : "Read one with read_session; search its content with search_messages { sessionId }; message it with send_to_session.",
      };
    },
  };

  const getMessageContext: JinnMcpTool = {
    name: "get_message_context",
    description:
      `Read the messages around a search hit from search_messages: given { sessionId, messageId }, returns the ±radius surrounding messages (default ${CONTEXT_RADIUS_DEFAULT}, max ${CONTEXT_RADIUS_MAX}; long messages truncated). Read-only; there is no full-transcript mode — if the window isn't enough, ask the session to summarize.`,
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session the hit is in." },
        messageId: { type: "string", description: "The anchor message id (from a search_messages hit)." },
        radius: { type: "number", description: `Messages each side of the anchor (1–${CONTEXT_RADIUS_MAX}, default ${CONTEXT_RADIUS_DEFAULT}).` },
      },
      required: ["sessionId", "messageId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const sessionId = requireString(args, "sessionId");
      const messageId = requireString(args, "messageId");
      const radius = clampInt(args.radius, CONTEXT_RADIUS_DEFAULT, 1, CONTEXT_RADIUS_MAX);
      const path = `/api/sessions/${encodeURIComponent(sessionId)}/context?${qs({ message: messageId, radius })}`;
      const { status, body } = await gatewayGet(ctx, path);
      if (status >= 400) throw gatewayFailure(`reading context for message "${messageId}" in session "${sessionId}"`, status, body);
      const rec = (body ?? {}) as {
        session?: Record<string, unknown>;
        anchorMessageId?: string;
        messages?: Array<Record<string, unknown>>;
      };
      return {
        session: rec.session ? summarizeSession(rec.session) : null,
        anchorMessageId: rec.anchorMessageId,
        messages: Array.isArray(rec.messages) ? rec.messages : [],
        hint: "For the session's CURRENT state use read_session; to act on this, message the session (send_to_session) or your manager.",
      };
    },
  };

  return [searchMessages, searchSessions, getMessageContext];
}
