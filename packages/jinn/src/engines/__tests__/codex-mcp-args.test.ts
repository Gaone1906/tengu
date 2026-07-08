import { describe, it, expect } from "vitest";
import { codexMcpConfigArgs } from "../codex.js";
import type { ResolvedMcpConfig } from "../../shared/types.js";

/**
 * GRS-012b — Codex is the first non-Claude consumer of the wave-30 `resolvedMcp`
 * payload. These tests pin the `-c mcp_servers.*` overrides the adapter emits so a
 * spawned `codex exec` attaches the jinn server per-session without touching the
 * operator's global ~/.codex/config.toml — and, critically, that NO secret is
 * serialized into argv.
 */

describe("codexMcpConfigArgs", () => {
  it("emits nothing when there is no resolved MCP config", () => {
    expect(codexMcpConfigArgs(undefined)).toEqual([]);
    expect(codexMcpConfigArgs({ mcpServers: {} })).toEqual([]);
  });

  it("emits command + args -c overrides for a stdio server", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: { command: "/usr/bin/node", args: ["/abs/dist/src/mcp/server-entry.js"] },
      },
    };
    const args = codexMcpConfigArgs(resolved);
    expect(args).toEqual([
      "-c",
      'mcp_servers.jinn.command="/usr/bin/node"',
      "-c",
      'mcp_servers.jinn.args=["/abs/dist/src/mcp/server-entry.js"]',
    ]);
  });

  it("emits the non-secret env as a TOML inline table when present", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: {
          command: "/usr/bin/node",
          args: ["/abs/entry.js"],
          env: { JINN_GATEWAY_URL: "http://127.0.0.1:7788" },
        },
      },
    };
    const args = codexMcpConfigArgs(resolved);
    expect(args).toContain("-c");
    expect(args).toContain('mcp_servers.jinn.env={JINN_GATEWAY_URL="http://127.0.0.1:7788"}');
  });

  it("DROPS non-allowlisted (secret) env keys from argv — only JINN_GATEWAY_URL is emitted", () => {
    // A custom/search server whose env carries a resolved secret must NOT leak it
    // into the world-readable process argv; only the non-secret gateway URL passes.
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        search: {
          command: "npx",
          args: ["-y", "brave-search-mcp"],
          env: { BRAVE_API_KEY: "sk-super-secret", JINN_GATEWAY_URL: "http://127.0.0.1:7777" },
        },
      },
    };
    const joined = codexMcpConfigArgs(resolved).join(" ");
    expect(joined).not.toContain("sk-super-secret");
    expect(joined).not.toContain("BRAVE_API_KEY");
    // The command/args still emit; only the URL survives in env.
    expect(joined).toContain('mcp_servers.search.command="npx"');
    expect(joined).toContain('mcp_servers.search.env={JINN_GATEWAY_URL="http://127.0.0.1:7777"}');
  });

  it("emits no env clause at all when a server has only secret (non-allowlisted) env", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: { custom: { command: "run", args: [], env: { TOKEN: "leak-me" } } },
    };
    const joined = codexMcpConfigArgs(resolved).join(" ");
    expect(joined).not.toContain("leak-me");
    expect(joined).not.toContain(".env=");
  });

  it("does NOT serialize a bearer token — only what the resolver put in env reaches argv", () => {
    // The resolver never places the token in server.env; assert the emit path
    // itself carries nothing token-shaped for the jinn server's real (URL-only) env.
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: { command: "node", args: ["/e.js"], env: { JINN_GATEWAY_URL: "http://127.0.0.1:7777" } },
      },
    };
    const joined = codexMcpConfigArgs(resolved).join(" ");
    expect(joined).not.toMatch(/TOKEN/i);
    expect(joined).not.toMatch(/authorization/i);
  });

  it("skips URL-based (non-stdio) servers this slice", () => {
    const resolved: ResolvedMcpConfig = {
      // Cast: a URL server has no `command`; the emitter must skip it.
      mcpServers: { remote: { type: "sse", url: "http://example/mcp" } as never },
    };
    expect(codexMcpConfigArgs(resolved)).toEqual([]);
  });

  it("handles multiple stdio servers independently", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: { command: "node", args: ["/j.js"] },
        search: { command: "npx", args: ["-y", "brave-search-mcp"] },
      },
    };
    const args = codexMcpConfigArgs(resolved);
    expect(args).toContain('mcp_servers.jinn.command="node"');
    expect(args).toContain('mcp_servers.search.command="npx"');
    expect(args).toContain('mcp_servers.search.args=["-y","brave-search-mcp"]');
  });
});
