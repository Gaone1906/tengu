import { assertBoundCaller, gatewayGet, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";

/**
 * docs/tengu/18-council-specialists.md — the repo-knowledge tool group of the
 * `jinn` MCP server: a specialist searches its OWN repo's RAG-indexed
 * knowledge base (`~/.{instance}/kb/<employeeName>/`) through
 * `search_repo_knowledge` (index-only, capped hits) and pulls one chunk's
 * full text on demand with `read_repo_chunk`. Same budget shape as
 * `knowledge-tools.ts`'s company-knowledge pair: search never inlines
 * bodies, read is the one place a chunk's full text appears, and both are
 * read-tier (bound-caller-only).
 *
 * SCOPING (the load-bearing rule this module exists to enforce): neither
 * tool's input schema takes an employee/repo argument. `:name` in the
 * gateway route is always resolved server-side from the CALLING SESSION's
 * own bound employee (`GET /api/sessions/:id` → `.employee`, then
 * `GET /api/org/employees/:name` → `.repo`) — never from a tool argument a
 * caller could supply to name a different specialist. A generalist session
 * (no bound employee, or an employee with no `repo`) is refused before any
 * KB call: generalists have no repo KB to search.
 */

export const REPO_KNOWLEDGE_QUERY_CHAR_CAP = 512;
const DEFAULT_SEARCH_K = 8;
const MAX_SEARCH_K = 20;

function requireString(args: Record<string, unknown>, name: string, max: number): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  if (s.length > max) {
    throw new JinnMcpToolError(`${name} is too long (${s.length} chars, max ${max}) — shorten it and try again`);
  }
  return s;
}

function clampSearchK(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_SEARCH_K;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new JinnMcpToolError("k must be a positive number when provided");
  }
  return Math.min(MAX_SEARCH_K, Math.floor(value));
}

function requireChunkId(args: Record<string, unknown>): number {
  const v = args.chunkId;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
    throw new JinnMcpToolError("chunkId is required and must be a positive integer (from a search_repo_knowledge hit)");
  }
  return v;
}

function asText(body: unknown, max = 500): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 404) return new JinnMcpToolError(`${what} failed (404): ${detail}`);
  if (status === 403) return new JinnMcpToolError(`${what} refused (403): ${detail}`);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

/**
 * Resolve the calling session's own bound specialist identity — the ONLY
 * source of `{name, repo}` these tools ever act on. Two gateway round trips
 * (session → its bound employee, then that employee's record), both
 * read-tier and both already-existing routes (`session-tools.ts`,
 * `org-tools.ts` use the same two respectively) — no new identity plumbing.
 */
async function resolveCallerSpecialist(ctx: JinnMcpContext): Promise<{ name: string; repo: string }> {
  assertBoundCaller(ctx);
  const sessionRes = await gatewayGet(ctx, `/api/sessions/${encodeURIComponent(ctx.callerSessionId)}`);
  if (sessionRes.status >= 400) throw gatewayFailure("resolving your session identity", sessionRes.status, sessionRes.body);
  const session = (sessionRes.body ?? {}) as { employee?: string | null };
  const employeeName = typeof session.employee === "string" && session.employee.trim() ? session.employee.trim() : undefined;
  if (!employeeName) {
    throw new JinnMcpToolError(
      "this session has no bound employee — repo knowledge tools are specialist-only; a plain or COO session has no repo KB to search.",
    );
  }

  const empRes = await gatewayGet(ctx, `/api/org/employees/${encodeURIComponent(employeeName)}`);
  if (empRes.status >= 400) throw gatewayFailure(`resolving employee "${employeeName}"`, empRes.status, empRes.body);
  const emp = (empRes.body ?? {}) as { name?: string; repo?: string };
  if (!emp.repo) {
    throw new JinnMcpToolError(
      `"${employeeName}" has no repo configured — repo knowledge tools are specialist-only; generalists have no repo KB.`,
    );
  }
  return { name: emp.name ?? employeeName, repo: emp.repo };
}

export function buildRepoKnowledgeTools(): JinnMcpTool[] {
  const searchRepoKnowledge: JinnMcpTool = {
    name: "search_repo_knowledge",
    description: "Search your own repo's indexed knowledge base; snippets only, scoped to your bound identity.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "number" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const query = requireString(args, "query", REPO_KNOWLEDGE_QUERY_CHAR_CAP);
      const k = clampSearchK(args.k);
      const specialist = await resolveCallerSpecialist(ctx);
      const { status, body } = await gatewayGet(
        ctx,
        `/api/specialists/${encodeURIComponent(specialist.name)}/kb/search?q=${encodeURIComponent(query)}&k=${k}`,
      );
      if (status >= 400) throw gatewayFailure("searching your repo knowledge base", status, body);
      const rec = (body ?? {}) as { chunks?: Array<Record<string, unknown>> };
      const chunks = Array.isArray(rec.chunks) ? rec.chunks : [];
      return {
        query,
        chunks,
        hint:
          chunks.length === 0
            ? "No hits. Try fewer/different words."
            : "Next: read_repo_chunk { chunkId } for a hit's full, untruncated text.",
      };
    },
  };

  const readRepoChunk: JinnMcpTool = {
    name: "read_repo_chunk",
    description: "Read one full chunk from your own repo knowledge base by chunkId (from a search_repo_knowledge hit).",
    inputSchema: {
      type: "object",
      properties: {
        chunkId: { type: "number" },
      },
      required: ["chunkId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const chunkId = requireChunkId(args);
      const specialist = await resolveCallerSpecialist(ctx);
      const { status, body } = await gatewayGet(
        ctx,
        `/api/specialists/${encodeURIComponent(specialist.name)}/kb/chunks/${chunkId}`,
      );
      if (status === 404) {
        throw new JinnMcpToolError(
          `chunk ${chunkId} not found in your knowledge base — chunk ids come from search_repo_knowledge hits, not guesses.`,
        );
      }
      if (status >= 400) throw gatewayFailure(`reading chunk ${chunkId}`, status, body);
      const rec = (body ?? {}) as { chunk?: Record<string, unknown> };
      return {
        chunk: rec.chunk ?? null,
        hint: "Cite path:startLine-endLine when useful.",
      };
    },
  };

  return [searchRepoKnowledge, readRepoChunk];
}
