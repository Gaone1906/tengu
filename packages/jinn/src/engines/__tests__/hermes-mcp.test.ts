// packages/jinn/src/engines/__tests__/hermes-mcp.test.ts
/**
 * GRS-018 — Hermes is the third non-Claude consumer of the resolved MCP set.
 * The ACP `session/new`/`session/load` params carry `mcpServers` as an array of
 * ACP `McpServerStdio` objects ({name, command, args, env: [{name, value}]}).
 *
 * Two contracts pinned here:
 *  1. Shape: the mapper emits the exact ACP wire shape (env as name/value PAIRS,
 *     not a map) for every stdio server; URL-transport servers are skipped.
 *  2. Token: Hermes builds a FILTERED env for MCP stdio subprocesses (its
 *     `_build_safe_env` passes only PATH/HOME/XDG_* + explicitly-configured
 *     keys), so — unlike codex/grok, whose spawned servers inherit the gateway's
 *     env — the jinn server under Hermes would never see JINN_GATEWAY_TOKEN.
 *     The mapper therefore injects the token from the gateway's own process env
 *     into the BUILT-IN jinn server's ACP env entry. The ACP channel is an
 *     in-memory stdin pipe (never argv, never a file), so the no-secret-on-disk
 *     contract holds.
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildAcpMcpServers } from "../hermes-mcp.js";
import type { ResolvedMcpConfig } from "../../shared/types.js";

const ORIGINAL_TOKEN = process.env.JINN_GATEWAY_TOKEN;

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.JINN_GATEWAY_TOKEN;
  else process.env.JINN_GATEWAY_TOKEN = ORIGINAL_TOKEN;
});

describe("buildAcpMcpServers", () => {
  it("returns [] for undefined / empty resolved sets", () => {
    expect(buildAcpMcpServers(undefined)).toEqual([]);
    expect(buildAcpMcpServers({ mcpServers: {} })).toEqual([]);
  });

  it("maps a stdio server to the ACP wire shape with env as name/value pairs", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        search: {
          command: "npx",
          args: ["-y", "brave-search-mcp"],
          env: { BRAVE_API_KEY: "bk-123" },
        },
      },
    };
    expect(buildAcpMcpServers(resolved)).toEqual([
      {
        name: "search",
        command: "npx",
        args: ["-y", "brave-search-mcp"],
        env: [{ name: "BRAVE_API_KEY", value: "bk-123" }],
      },
    ]);
  });

  it("emits args/env as empty arrays when the spec omits them", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: { fetch: { command: "npx" } },
    };
    expect(buildAcpMcpServers(resolved)).toEqual([
      { name: "fetch", command: "npx", args: [], env: [] },
    ]);
  });

  it("skips URL-transport servers (stdio only this slice)", () => {
    const resolved = {
      mcpServers: {
        remote: { type: "sse", url: "https://example.com/mcp" },
        local: { command: "npx", args: ["x"] },
      },
    } as unknown as ResolvedMcpConfig;
    const out = buildAcpMcpServers(resolved);
    expect(out.map((s) => s.name)).toEqual(["local"]);
  });

  it("injects JINN_GATEWAY_TOKEN from the gateway process env into the built-in jinn server only", () => {
    process.env.JINN_GATEWAY_TOKEN = "tok-secret";
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: { command: "/usr/bin/node", args: ["/dist/mcp/server-entry.js"], env: { JINN_GATEWAY_URL: "http://127.0.0.1:7777" } },
        search: { command: "npx", args: [] },
      },
    };
    const out = buildAcpMcpServers(resolved);
    const jinn = out.find((s) => s.name === "jinn")!;
    expect(jinn.env).toContainEqual({ name: "JINN_GATEWAY_URL", value: "http://127.0.0.1:7777" });
    expect(jinn.env).toContainEqual({ name: "JINN_GATEWAY_TOKEN", value: "tok-secret" });
    // Never leak the token onto other servers.
    const search = out.find((s) => s.name === "search")!;
    expect(search.env).toEqual([]);
  });

  it("does NOT inject a token entry when the gateway has none, and never duplicates an explicit one", () => {
    delete process.env.JINN_GATEWAY_TOKEN;
    const noToken = buildAcpMcpServers({ mcpServers: { jinn: { command: "node" } } });
    expect(noToken[0].env).toEqual([]);

    process.env.JINN_GATEWAY_TOKEN = "tok-env";
    const explicit = buildAcpMcpServers({
      mcpServers: { jinn: { command: "node", env: { JINN_GATEWAY_TOKEN: "tok-explicit" } } },
    });
    const entries = explicit[0].env.filter((e) => e.name === "JINN_GATEWAY_TOKEN");
    expect(entries).toEqual([{ name: "JINN_GATEWAY_TOKEN", value: "tok-explicit" }]);
  });
});
