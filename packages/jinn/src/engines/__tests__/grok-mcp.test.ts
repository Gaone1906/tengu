import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedMcpConfig, McpServerStdioConfig } from "../../shared/types.js";
import {
  buildGrokMcpToml,
  prepareGrokProjectMcpConfig,
  cleanupGrokProjectMcpConfig,
  JINN_GROK_MCP_MARKER,
} from "../grok-mcp.js";

/**
 * GRS-012c — Grok is wired to attach the built-in `jinn` MCP server via a
 * `<cwd>/.grok/config.toml`. Because every jinn-spawned turn runs with the SHARED
 * `cwd = JINN_HOME`, the file is reference-counted and only the `jinn` server is
 * emitted. These pure tests cover the TOML emit, the jinn-only filter, the
 * no-clobber guard, the refcounted shared-file lifecycle, and the secret-env
 * allowlist.
 */

const jinnSpec: McpServerStdioConfig = {
  command: "/usr/bin/node",
  args: ["/abs/path/dist/src/mcp/server-entry.js"],
  env: { JINN_GATEWAY_URL: "http://127.0.0.1:7788" },
};
const JINN_SERVER: ResolvedMcpConfig = { mcpServers: { jinn: jinnSpec } };

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("buildGrokMcpToml", () => {
  it("renders a valid [mcp_servers.jinn] stdio block with an env table", () => {
    const toml = buildGrokMcpToml("jinn", jinnSpec);
    expect(toml).toContain("[mcp_servers.jinn]");
    expect(toml).toContain('command = "/usr/bin/node"');
    expect(toml).toContain('args = ["/abs/path/dist/src/mcp/server-entry.js"]');
    expect(toml).toContain("enabled = true");
    expect(toml).toContain("[mcp_servers.jinn.env]");
    expect(toml).toContain('JINN_GATEWAY_URL = "http://127.0.0.1:7788"');
  });

  it("drops secret-bearing env keys from the on-disk config (allowlist only)", () => {
    const toml = buildGrokMcpToml("jinn", {
      command: "node",
      args: ["entry.js"],
      env: { BRAVE_API_KEY: "sk-secret", JINN_GATEWAY_URL: "http://x" },
    });
    expect(toml).not.toContain("BRAVE_API_KEY");
    expect(toml).not.toContain("sk-secret");
    expect(toml).toContain('JINN_GATEWAY_URL = "http://x"');
  });

  it("omits the env table entirely when no safe keys remain", () => {
    const toml = buildGrokMcpToml("jinn", { command: "cmd", env: { SECRET: "x" } });
    expect(toml).not.toContain(".env]");
    expect(toml).not.toContain("SECRET");
  });
});

describe("prepareGrokProjectMcpConfig", () => {
  it("writes a marked .grok/config.toml into the session cwd for the jinn server", () => {
    const handle = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    expect(handle.attached).toBe(true);
    if (!handle.attached) throw new Error("unreachable");
    const content = fs.readFileSync(handle.configPath, "utf-8");
    expect(content.startsWith(JINN_GROK_MCP_MARKER)).toBe(true);
    expect(content).toContain("[mcp_servers.jinn]");
    expect(handle.configPath).toBe(path.join(tmp, ".grok", "config.toml"));
    cleanupGrokProjectMcpConfig(handle);
  });

  it("no-ops when the resolved set has no jinn server", () => {
    expect(prepareGrokProjectMcpConfig(tmp, undefined).attached).toBe(false);
    expect(prepareGrokProjectMcpConfig(tmp, { mcpServers: {} }).attached).toBe(false);
    // Non-jinn servers are NOT emitted this slice (jinn-only scope).
    const others: ResolvedMcpConfig = {
      mcpServers: {
        browser: { command: "npx", args: ["-y", "browser"] } as any,
        "corp.search": { command: "npx", args: ["--api-key", "sk-live"] } as any,
        remote: { type: "sse", url: "http://x" } as any,
      },
    };
    expect(prepareGrokProjectMcpConfig(tmp, others).attached).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".grok"))).toBe(false);
  });

  it("rejects a jinn key that is a URL-transport server (not the built-in stdio)", () => {
    const urlJinn: ResolvedMcpConfig = { mcpServers: { jinn: { type: "sse", url: "http://evil", command: "node" } as any } };
    expect(prepareGrokProjectMcpConfig(tmp, urlJinn).attached).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".grok"))).toBe(false);
  });

  it("does NOT clobber a user's own pre-existing .grok/config.toml", () => {
    const grokDir = path.join(tmp, ".grok");
    fs.mkdirSync(grokDir);
    const userConfig = '[model]\ndefault = "grok-4"\n';
    fs.writeFileSync(path.join(grokDir, "config.toml"), userConfig);

    const handle = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    expect(handle.attached).toBe(false); // skipped, no clobber
    expect(fs.readFileSync(path.join(grokDir, "config.toml"), "utf-8")).toBe(userConfig);
  });
});

describe("cleanupGrokProjectMcpConfig — refcounted shared file (SHARED cwd = JINN_HOME)", () => {
  it("removes the marked file and the dir it created when the last session settles", () => {
    const handle = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    expect(handle.attached).toBe(true);
    cleanupGrokProjectMcpConfig(handle);
    expect(fs.existsSync(path.join(tmp, ".grok", "config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".grok"))).toBe(false); // dir we created, now removed
  });

  it("keeps the shared file until the LAST concurrent session settles (no cross-delete)", () => {
    // Two grok sessions in the same (shared) cwd — the JINN_HOME reality.
    const a = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    const b = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    expect(a.attached && b.attached).toBe(true);
    const configPath = path.join(tmp, ".grok", "config.toml");
    expect(fs.existsSync(configPath)).toBe(true);

    // Session A finishes first — must NOT delete the file B's grok is using.
    cleanupGrokProjectMcpConfig(a);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toContain("[mcp_servers.jinn]");

    // Session B (last) finishes — now the file is gone → zero residue.
    cleanupGrokProjectMcpConfig(b);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".grok"))).toBe(false);
  });

  it("leaves a pre-existing .grok dir in place, removing only our file", () => {
    const grokDir = path.join(tmp, ".grok");
    fs.mkdirSync(grokDir);
    fs.writeFileSync(path.join(grokDir, "config.toml"), `${JINN_GROK_MCP_MARKER}\n# stale\n`);
    const handle = prepareGrokProjectMcpConfig(tmp, JINN_SERVER); // overwrites stale marked file; createdDir=false
    cleanupGrokProjectMcpConfig(handle);
    expect(fs.existsSync(path.join(grokDir, "config.toml"))).toBe(false); // our file gone
    expect(fs.existsSync(grokDir)).toBe(true); // dir preserved (we didn't create it)
  });

  it("never deletes a file that no longer carries our marker (user replaced it mid-run)", () => {
    const handle = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    expect(handle.attached).toBe(true);
    if (!handle.attached) throw new Error("unreachable");
    fs.writeFileSync(handle.configPath, '[model]\ndefault = "grok-4"\n');
    cleanupGrokProjectMcpConfig(handle);
    expect(fs.existsSync(handle.configPath)).toBe(true);
    expect(fs.readFileSync(handle.configPath, "utf-8")).not.toContain(JINN_GROK_MCP_MARKER);
  });

  it("is idempotent and a no-op for an unattached handle", () => {
    const handle = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    cleanupGrokProjectMcpConfig(handle);
    expect(() => cleanupGrokProjectMcpConfig(handle)).not.toThrow(); // second call safe
    expect(() => cleanupGrokProjectMcpConfig({ attached: false })).not.toThrow();
  });

  it("a DOUBLE cleanup of one handle does not over-decrement the shared refcount", () => {
    // A + B share the file. Cleaning up A twice must NOT free the file B still uses.
    const a = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    const b = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    const configPath = path.join(tmp, ".grok", "config.toml");
    cleanupGrokProjectMcpConfig(a);
    cleanupGrokProjectMcpConfig(a); // idempotent per-handle → count stays at 1, not 0
    expect(fs.existsSync(configPath)).toBe(true); // B still using it
    cleanupGrokProjectMcpConfig(b);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("re-checks the marker in the concurrent-entry branch (user file mid-run is not falsely attached)", () => {
    const a = prepareGrokProjectMcpConfig(tmp, JINN_SERVER);
    expect(a.attached).toBe(true);
    if (!a.attached) throw new Error("unreachable");
    // User replaces our shared file with their own non-marked config while A is live.
    fs.writeFileSync(a.configPath, '[model]\ndefault = "grok-4"\n');
    const b = prepareGrokProjectMcpConfig(tmp, JINN_SERVER); // entry exists → but file now non-marked
    expect(b.attached).toBe(false); // not falsely attached; user file preserved
    expect(fs.readFileSync(a.configPath, "utf-8")).not.toContain(JINN_GROK_MCP_MARKER);
    cleanupGrokProjectMcpConfig(a);
    cleanupGrokProjectMcpConfig(b);
  });
});
