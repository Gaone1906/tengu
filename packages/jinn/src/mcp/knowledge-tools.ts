import { assertBoundCaller, gatewayGet, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import { hasControlBytes } from "../shared/sanitize.js";

/**
 * GRS-020b — the knowledge tool group of the `jinn` MCP server: agents search
 * the company's institutional knowledge (`~/.jinn/knowledge/*.md` +
 * `~/.jinn/docs/*.md`) and read ONE instance file — replacing the ~100-file knowledge
 * index pasted into every MCP-attached bootstrap (the conditional diet in
 * sessions/context.ts).
 *
 * Domain rules this module owns:
 *   - INSTANCE-ROOT INVARIANT (enforced in knowledge/store.ts behind the
 *     routes): reads accept any relative instance file, while realpath
 *     containment rejects `..`, absolute paths, and symlink escapes.
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
    description: "Search knowledge/ and docs/ markdown; snippets only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
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
            ? "No hits. Try fewer words."
            : "Next: read_knowledge { path }.",
      };
    },
  };

  const readKnowledge: JinnMcpTool = {
    name: "read_knowledge",
    description: "Read one instance file by relative path; long files are capped.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      if (typeof args.path === "string" && hasControlBytes(args.path)) {
        throw new JinnMcpToolError(
          "path contains control bytes — pass the instance-relative path exactly",
        );
      }
      const relPath = requireString(args, "path", KNOWLEDGE_PATH_CHAR_CAP);
      const { status, body } = await gatewayGet(ctx, `/api/knowledge/read?path=${encodeURIComponent(relPath)}`);
      if (status >= 400) throw gatewayFailure(`reading instance file "${relPath}"`, status, body);
      const rec = (body ?? {}) as { path?: string; title?: string; content?: string; truncated?: boolean; totalChars?: number };
      return {
        path: rec.path ?? relPath,
        title: rec.title ?? null,
        truncated: rec.truncated === true,
        content: typeof rec.content === "string" ? rec.content : "",
        hint: "Cite path when useful.",
      };
    },
  };

  return [searchKnowledge, readKnowledge];
}
