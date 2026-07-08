// packages/jinn/src/mcp/env-scrub.ts
import { fileURLToPath } from "node:url";
import type { McpServerConfig, McpServerStdioConfig } from "../shared/types.js";

/** The reserved built-in gateway server key (matches mcp/resolver.ts, which
 *  reserves this name so no custom server can occupy it). Exempt from scrubbing:
 *  its inherited token is the proven auth path. */
const JINN_BUILTIN_SERVER = "jinn";

/**
 * GRS-018 hardening (§3a) — env-scrub wrap for THIRD-PARTY MCP servers.
 *
 * The gateway boot exports JINN_GATEWAY_TOKEN onto its own process.env so every
 * engine child (the employee request path) inherits it — load-bearing, HELD.
 * But the vendor CLIs that spawn MCP stdio servers pass their FULL environment
 * to those servers (empirically: claude forwards 77 keys incl. the token, grok
 * 78 — see GRS-018-credential-scope-analysis.md). A third-party server process
 * (npm supply chain) then holds a gateway credential it never needed.
 *
 * We can't change the vendor CLI's spawn policy, and we must NOT strip the
 * ENGINE process env (that breaks the employee curl path). The one point jinn
 * controls uniformly is the resolved server SPEC. So every non-builtin stdio
 * server's `command` is replaced with a tiny node launcher ({@link
 * SCRUB_ENTRY_BASENAME}) that deletes JINN_GATEWAY_TOKEN from its own env and
 * then execs the real command — the child third-party server never sees the
 * token. The builtin `jinn` server is EXEMPT: its inherited token is the proven
 * auth path (GRS-018 item 2), and it is jinn's own trusted code.
 *
 * The non-secret JINN_GATEWAY_URL is deliberately NOT stripped (some servers
 * legitimately want a local URL, and it carries no secret).
 *
 * Belt-and-braces across engines: claude reads the wrapped spec from its
 * --mcp-config file; codex/grok already spawn MCP servers with a clean/filtered
 * env (so the wrap is redundant but harmless there); hermes filters too. Keeping
 * ONE wrapped shape in the resolver means the guarantee holds no matter which
 * engine consumes the set, and future third-party attach paths inherit it free.
 */

/** Basename of the compiled launcher (sits next to this module in dist). */
export const SCRUB_ENTRY_BASENAME = "scrub-entry.js";

/** Absolute path to the compiled scrub launcher, resolved robustly across
 *  worktree/dist without a hardcoded path. */
function scrubEntryPath(): string {
  return fileURLToPath(new URL(`./${SCRUB_ENTRY_BASENAME}`, import.meta.url));
}

/**
 * Anti-spoof idempotency (GRS-018 joint-review critical). The ONLY specs exempt
 * from wrapping are ones THIS module produced — tracked by OBJECT IDENTITY in a
 * private WeakSet, never by inspecting command/args content.
 *
 * Why not a path/basename/marker match: any content-based check is spoofable
 * because a third-party server config is attacker-controlled data.
 *   - basename suffix "scrub-entry.js" — the original bug: a config command
 *     `node any/scrub-entry.js` dodged the wrap and inherited the token (proven).
 *   - exact absolute path — jinn is OPEN SOURCE, so the dist path is guessable;
 *     `node <that-exact-path> <cmd>` would still appear pre-wrapped.
 *   - a static arg/env marker — a source-reader can copy the literal into their
 *     config args (replayable).
 * Object identity has none of these holes: a config-supplied object can never be
 * in a WeakSet only we add to, and identity is not a value config can forge or
 * replay. A config command that merely LOOKS like our launcher is treated as
 * untrusted and IS wrapped. Genuine idempotency (wrap(wrap(x))) still holds
 * because the inner pass's output objects ARE in the set. Entries GC with their
 * objects, so the set never grows unbounded.
 */
const scrubWrapped = new WeakSet<object>();

/**
 * Return a copy of a resolved server map where every NON-builtin stdio server's
 * command is wrapped in the env-scrub launcher. Pure — never mutates the input,
 * and leaves the builtin `jinn` server and URL-transport servers by reference.
 */
export function wrapServersWithScrub(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  const scrubEntry = scrubEntryPath();
  for (const [name, spec] of Object.entries(servers)) {
    // Builtin jinn: exempt (proven auth path). URL servers: no command to wrap.
    const stdio = spec as McpServerStdioConfig & { url?: unknown };
    if (name === JINN_BUILTIN_SERVER || typeof stdio.command !== "string" || !stdio.command || stdio.url !== undefined) {
      out[name] = spec;
      continue;
    }
    // Exempt ONLY a wrapper WE created (object identity) — never a config shape.
    if (scrubWrapped.has(spec)) {
      out[name] = spec;
      continue;
    }
    const wrapped: McpServerStdioConfig = {
      ...stdio,
      command: process.execPath,
      args: [scrubEntry, stdio.command, ...(stdio.args ?? [])],
    };
    scrubWrapped.add(wrapped);
    out[name] = wrapped;
  }
  return out;
}
