import { assertBoundCaller, gatewayGet, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";

/**
 * GRS-020b — the knowledge tool group of the `jinn` MCP server: agents search
 * the company's institutional knowledge (`~/.jinn/knowledge/*.md` +
 * `~/.jinn/docs/*.md`) and read ONE hit — replacing the ~100-file knowledge
 * index pasted into every MCP-attached bootstrap (the conditional diet in
 * sessions/context.ts).
 *
 * Domain rules this module owns:
 *   - SCOPED-ROOT INVARIANT (design §3, enforced in knowledge/store.ts behind
 *     the routes): only the two allowlisted roots are searchable/readable —
 *     paths are shape-gated AND realpath-contained, so `..`, absolute paths,
 *     and symlink escapes are refused by the substrate. The tools never build
 *     paths themselves; they pass the relative path a search hit returned.
 *   - CONTEXT-BOMB GUARDS: search returns ≤20 {path,title,snippet,matchCount}
 *     hits (snippets ~12 words, never bodies); read returns ONE file capped at
 *     ~20 KB with the intentional-cap marker.
 *   - READ TIER: these are privileged company reads. Tool-marked or
 *     caller-session-claimed requests must carry a valid bound session
 *     capability; operator/browser reads without those headers remain unchanged.
 *   - LENGTH CAPS (the 020a-fix finding-3 pattern): query/path are capped
 *     tool-side with a structured error BEFORE the HTTP call.
 *   - TEACHING lives on search_knowledge; read_knowledge stays short.
 */

/** Tool-side query cap (route backstop is 1,024 — the tool fails first, friendlier). */
export const KNOWLEDGE_QUERY_CHAR_CAP = 512;
/** Tool-side relative-path cap (real paths are far shorter). */
export const KNOWLEDGE_PATH_CHAR_CAP = 300;

/** GRS-020b-fix: REJECT (never strip) control bytes on the RAW path arg. A
 *  trailing `%00`/NUL survives `.trim()`, and the gateway route's free-text
 *  cleaner would strip-then-accept it — so the tool fails first, on the raw
 *  value, before any normalization. Local codepoint predicate keeps this MCP
 *  module free of a sessions/registry (better-sqlite3) import. */
function hasControlBytes(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function requireString(args: Record<string, unknown>, name: string, max: number): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  if (s.length > max) {
    throw new JinnMcpToolError(`${name} is too long (${s.length} chars, max ${max}) — shorten it and try again`);
  }
  return s;
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
  if (status === 403) return new JinnMcpToolError(`${what} refused (403): ${detail}`);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

export function buildKnowledgeTools(): JinnMcpTool[] {
  const searchKnowledge: JinnMcpTool = {
    name: "search_knowledge",
    description:
      "Search the company's institutional knowledge — the operator-curated markdown libraries in knowledge/ (research, strategies, profiles) and docs/ (platform docs). Query is plain words (case-insensitive; ALL words must appear in a file's name or content; deterministic, no LLM). Returns up to 20 hits {path, title, snippet, matchCount} — snippets only, never file bodies; read a hit with read_knowledge { path }. Nothing outside knowledge/ and docs/ is searchable or readable.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: `Plain words to search for (all must appear; max ${KNOWLEDGE_QUERY_CHAR_CAP} chars).` },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const query = requireString(args, "query", KNOWLEDGE_QUERY_CHAR_CAP);
      const { status, body } = await gatewayGet(ctx, `/api/knowledge/search?q=${encodeURIComponent(query)}`);
      if (status >= 400) throw gatewayFailure("searching knowledge", status, body);
      const rec = (body ?? {}) as { results?: Array<Record<string, unknown>> };
      const results = Array.isArray(rec.results) ? rec.results : [];
      return {
        query,
        results,
        hint:
          results.length === 0
            ? "No knowledge hits. Try fewer or different words (all must appear). The library covers curated company knowledge and platform docs only."
            : "Read a hit with read_knowledge { path } — cite the path when you use its content.",
      };
    },
  };

  const readKnowledge: JinnMcpTool = {
    name: "read_knowledge",
    description:
      'Read ONE knowledge file by the relative path a search_knowledge hit returned (e.g. "knowledge/pricing-strategy.md" or "docs/architecture.md"). Long files are truncated at ~20 KB with a marker. Only files inside knowledge/ and docs/ are reachable.',
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Relative path from a search hit — "knowledge/<file>.md" or "docs/<file>.md".' },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      if (typeof args.path === "string" && hasControlBytes(args.path)) {
        throw new JinnMcpToolError(
          "path contains control bytes — pass the relative path exactly as a search_knowledge hit returned it",
        );
      }
      const relPath = requireString(args, "path", KNOWLEDGE_PATH_CHAR_CAP);
      if (!/^(knowledge|docs)\//.test(relPath)) {
        throw new JinnMcpToolError(
          `path must start with "knowledge/" or "docs/" (the two readable roots) — got ${JSON.stringify(relPath.slice(0, 120))}. Get paths from search_knowledge.`,
        );
      }
      const { status, body } = await gatewayGet(ctx, `/api/knowledge/read?path=${encodeURIComponent(relPath)}`);
      if (status >= 400) throw gatewayFailure(`reading knowledge file "${relPath}"`, status, body);
      const rec = (body ?? {}) as { path?: string; title?: string; content?: string; truncated?: boolean; totalChars?: number };
      return {
        path: rec.path ?? relPath,
        title: rec.title ?? null,
        truncated: rec.truncated === true,
        content: typeof rec.content === "string" ? rec.content : "",
        hint: "Cite the path when you use this content. Search for related files with search_knowledge.",
      };
    },
  };

  return [searchKnowledge, readKnowledge];
}
