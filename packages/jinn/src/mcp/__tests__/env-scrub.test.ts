// packages/jinn/src/mcp/__tests__/env-scrub.test.ts
/**
 * GRS-018 hardening (§3a) — the resolver-level env-scrub wrap.
 *
 * Every NON-builtin stdio MCP server's command is wrapped in a launcher that
 * deletes JINN_GATEWAY_TOKEN from the child environment before exec. The
 * builtin `jinn` server is EXEMPT (its inherited token is the proven auth
 * path). URL-transport servers (no command) are untouched. The ENGINE process
 * env is never modified — only the spec the engine hands to the third-party
 * server subprocess.
 *
 * Two layers pinned:
 *   1. wrapServersWithScrub — pure spec transform (this file, unit).
 *   2. scrub-entry.js — the launcher actually strips + faithfully propagates
 *      exit code and signals (spawned for real below).
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapServersWithScrub, SCRUB_ENTRY_BASENAME } from "../env-scrub.js";
import type { McpServerConfig, McpServerStdioConfig } from "../../shared/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The compiled launcher sits next to the compiled env-scrub.js in dist. In the
// TS source tree we point the spawn tests at the dist build.
const DIST_SCRUB = path.resolve(HERE, "../../../dist/src/mcp", SCRUB_ENTRY_BASENAME);

describe("wrapServersWithScrub (pure spec transform)", () => {
  it("wraps a non-builtin stdio server: node <scrub> <realcmd> <realargs>, env preserved", () => {
    const servers: Record<string, McpServerConfig> = {
      search: { command: "npx", args: ["-y", "brave-search-mcp"], env: { BRAVE_API_KEY: "bk" } },
    };
    const out = wrapServersWithScrub(servers);
    const wrapped = out.search as McpServerStdioConfig;
    expect(wrapped.command).toBe(process.execPath);
    expect(wrapped.args?.[0]).toContain(SCRUB_ENTRY_BASENAME);
    expect(wrapped.args?.slice(1)).toEqual(["npx", "-y", "brave-search-mcp"]);
    // The server's own configured secret env must survive (the engine still
    // merges it in → the launcher passes it through to the child).
    expect(wrapped.env).toEqual({ BRAVE_API_KEY: "bk" });
  });

  it("leaves the builtin jinn server EXEMPT (byte-identical)", () => {
    const jinn: McpServerStdioConfig = { command: process.execPath, args: ["/dist/mcp/server-entry.js"], env: { JINN_GATEWAY_URL: "http://x" } };
    const out = wrapServersWithScrub({ jinn });
    expect(out.jinn).toBe(jinn); // same reference — untouched
  });

  it("leaves URL-transport servers untouched (no command to wrap)", () => {
    const servers = { remote: { type: "sse", url: "https://e/mcp" } } as unknown as Record<string, McpServerConfig>;
    const out = wrapServersWithScrub(servers);
    expect(out.remote).toBe(servers.remote);
  });

  it("wraps a server with no args/env and defaults args to just the real command", () => {
    const out = wrapServersWithScrub({ fetch: { command: "npx" } });
    const wrapped = out.fetch as McpServerStdioConfig;
    expect(wrapped.args?.slice(1)).toEqual(["npx"]);
    expect(wrapped.env).toBeUndefined();
  });

  it("is idempotent-safe: OUR OWN wrapped spec (object identity) is not double-wrapped", () => {
    const once = wrapServersWithScrub({ search: { command: "npx", args: ["x"] } });
    const twice = wrapServersWithScrub(once);
    const w = twice.search as McpServerStdioConfig;
    // exactly one scrub layer — the inner pass's object is in the private WeakSet
    expect(w.args?.filter((a) => a.includes(SCRUB_ENTRY_BASENAME)).length).toBe(1);
    // and it is the SAME object (exempted by identity, not re-created)
    expect(twice.search).toBe(once.search);
  });

  it("ANTI-SPOOF: a config command that merely LOOKS like our launcher is STILL wrapped", () => {
    // GRS-018 joint-review critical: `node <any>/scrub-entry.js` from config must
    // NOT be treated as pre-wrapped (it is not OUR object). It must be wrapped so
    // its child never inherits the token.
    const spoof: Record<string, McpServerConfig> = {
      evil: { command: process.execPath, args: ["/attacker/pkg/scrub-entry.js", "--payload"] },
    };
    const out = wrapServersWithScrub(spoof);
    const w = out.evil as McpServerStdioConfig;
    // Wrapped: our launcher is args[0], the spoof command is now the CHILD.
    expect(w.command).toBe(process.execPath);
    expect(w.args?.[0]).toContain(SCRUB_ENTRY_BASENAME);
    expect(w.args?.[1]).toBe(process.execPath);                 // their "node"
    expect(w.args?.[2]).toBe("/attacker/pkg/scrub-entry.js");   // their script, now scrubbed at runtime
    expect(w.args?.[3]).toBe("--payload");
    // Two scrub-entry.js occurrences: OURS (real launcher) + THEIRS (inert data).
    expect(w.args?.filter((a) => a.includes(SCRUB_ENTRY_BASENAME)).length).toBe(2);
    // Not the same object — it was re-created (wrapped), never exempted.
    expect(out.evil).not.toBe(spoof.evil);
  });

  it("ANTI-SPOOF: exact absolute-path of OUR launcher from config is also STILL wrapped", () => {
    // Even if an attacker guesses the exact dist path (jinn is open-source), a
    // config object is never in our WeakSet, so it is wrapped like any other.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const realLauncher = path.resolve(here, "../", SCRUB_ENTRY_BASENAME); // src-tree neighbor path
    const spoof: Record<string, McpServerConfig> = {
      evil: { command: process.execPath, args: [realLauncher, "id"] },
    };
    const w = wrapServersWithScrub(spoof).evil as McpServerStdioConfig;
    expect(w.args?.[0]).toContain(SCRUB_ENTRY_BASENAME); // OUR launcher prepended
    expect(w.args?.[1]).toBe(process.execPath);          // their command demoted to child
  });
});

describe("scrub-entry.js launcher (real spawn)", () => {
  it("strips JINN_GATEWAY_TOKEN from the child env, keeps everything else, propagates exit 0", async () => {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scrub-")), "env.json");
    const dumpScript = path.join(path.dirname(outFile), "dump.mjs");
    fs.writeFileSync(dumpScript, `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
  hasToken: "JINN_GATEWAY_TOKEN" in process.env,
  url: process.env.JINN_GATEWAY_URL ?? null,
  keep: process.env.SCRUB_KEEP_ME ?? null,
}));
process.exit(0);`);

    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [DIST_SCRUB, process.execPath, dumpScript], {
        env: { ...process.env, JINN_GATEWAY_TOKEN: "should-vanish", JINN_GATEWAY_URL: "http://keep", SCRUB_KEEP_ME: "yes" },
        stdio: "ignore",
      });
      child.on("exit", (c) => resolve(c ?? -1));
    });
    expect(code).toBe(0);
    const dumped = JSON.parse(fs.readFileSync(outFile, "utf-8"));
    expect(dumped.hasToken).toBe(false);        // token stripped
    expect(dumped.url).toBe("http://keep");     // non-secret URL kept
    expect(dumped.keep).toBe("yes");            // unrelated env kept
  }, 20_000);

  it("propagates a non-zero child exit code", async () => {
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scrub-")), "fail.mjs");
    fs.writeFileSync(script, "process.exit(42);");
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [DIST_SCRUB, process.execPath, script], { stdio: "ignore" });
      child.on("exit", (c) => resolve(c ?? -1));
    });
    expect(code).toBe(42);
  }, 20_000);

  it("propagates a terminating signal (child killed by SIGTERM → launcher exits by SIGTERM)", async () => {
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scrub-")), "hang.mjs");
    // Ignore nothing; just idle so the parent can kill the launcher.
    fs.writeFileSync(script, "setTimeout(() => {}, 60000);");
    const signal = await new Promise<string | null>((resolve) => {
      const child = spawn(process.execPath, [DIST_SCRUB, process.execPath, script], { stdio: "ignore" });
      child.on("exit", (_c, sig) => resolve(sig));
      setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }, 500);
    });
    expect(signal).toBe("SIGTERM");
  }, 20_000);
});
