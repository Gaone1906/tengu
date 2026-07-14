import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile } from "../resolver.js";
import { setJinnAttachGate } from "../attachment.js";
import type { Employee, McpGlobalConfig } from "../../shared/types.js";

/**
 * GRS-017e — the resolver consumes the ONE attachment decision point
 * (decideJinnAttachment): per-engine opt-out, per-employee force-on/off, the
 * smoke gate, and the default-on behavior introduced in v0.26.
 */

const emp = (extra: Partial<Employee> = {}): Employee => ({ name: "e", ...extra }) as Employee;

// GRS-017e-fix: the smoke gate is a mandatory conjunct of every positive
// attach decision (unarmed = fail closed), so positive-path resolver tests run
// with an armed-ok gate — exactly what a booted gateway provides. The
beforeEach(() => setJinnAttachGate({ ok: true }));
afterEach(() => setJinnAttachGate(null));

describe("default-on attachment", () => {
  it("adds jinn by default while retaining explicit global and employee opt-outs", () => {
    process.env.GRS17E_T = "expanded-secret-value";
    const cases: Array<{ id: string; globalMcp?: McpGlobalConfig; employee?: Employee }> = [
      { id: "no-global-no-emp" },
      { id: "no-global-emp", employee: emp({}) },
      { id: "empty-global", globalMcp: {} as McpGlobalConfig },
      { id: "fetch-only", globalMcp: { browser: { enabled: false }, fetch: { enabled: true } } },
      { id: "fetch-only-emp-false", globalMcp: { browser: { enabled: false }, fetch: { enabled: true } }, employee: emp({ mcp: false }) },
      { id: "fetch-only-allowlist", globalMcp: { browser: { enabled: false }, fetch: { enabled: true } }, employee: emp({ mcp: ["fetch"] }) },
      { id: "gateway-empty", globalMcp: { browser: { enabled: false }, gateway: {} } as McpGlobalConfig },
      {
        id: "gateway-false-custom",
        globalMcp: {
          browser: { enabled: false },
          gateway: { enabled: false },
          custom: { demo: { command: "run", args: ["--x"], env: { TOKEN: "${GRS17E_T}" } } },
        } as McpGlobalConfig,
      },
      { id: "gateway-absent-emp-requests-jinn", globalMcp: { browser: { enabled: false }, gateway: {} } as McpGlobalConfig, employee: emp({ mcp: ["jinn"] }) },
    ];
    for (const c of cases) {
      const expected = !["fetch-only-emp-false", "fetch-only-allowlist", "gateway-false-custom"].includes(c.id);
      const resolved = resolveMcpServers(c.globalMcp, c.employee).mcpServers;
      if (expected) expect(resolved, c.id).toHaveProperty("jinn");
      else expect(resolved, c.id).not.toHaveProperty("jinn");
      expect(Boolean(resolveMcpServers(c.globalMcp, c.employee, "codex").mcpServers.jinn), `${c.id} (engine)`).toBe(expected);
    }
    delete process.env.GRS17E_T;
  });

  it("the claude temp file includes the default-on built-in", () => {
    const p = writeMcpConfigFile(resolveMcpServers({ browser: { enabled: false }, fetch: { enabled: true } }), "grs017e-assert");
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
      expect(parsed.mcpServers).toHaveProperty("fetch");
      expect(parsed.mcpServers).toHaveProperty("jinn");
    } finally {
      cleanupMcpConfigFile("grs017e-assert");
    }
  });
});

describe("resolveMcpServers — per-engine opt-out threads through", () => {
  const cfg: McpGlobalConfig = {
    browser: { enabled: false },
    fetch: { enabled: true },
    gateway: { enabled: true, engines: { grok: false } },
  } as McpGlobalConfig;

  it("the opted-out engine loses ONLY the jinn server; other servers stay; other engines unaffected", () => {
    const grok = resolveMcpServers(cfg, emp(), "grok");
    expect(grok.mcpServers).not.toHaveProperty("jinn");
    expect(grok.mcpServers).toHaveProperty("fetch");
    const codex = resolveMcpServers(cfg, emp(), "codex");
    expect(codex.mcpServers).toHaveProperty("jinn");
    expect(codex.mcpServers).toHaveProperty("fetch");
  });

  it("an MCP-incapable engine name never gets jinn even when enabled (resolver-internal capability gate)", () => {
    const r = resolveMcpServers({ browser: { enabled: false }, gateway: { enabled: true } } as McpGlobalConfig, emp(), "unknown");
    expect(r.mcpServers).not.toHaveProperty("jinn");
  });
});

describe("resolveMcpServers — per-employee jinnMcp override", () => {
  it("force-on attaches jinn with the master ABSENT — even with no mcp: section at all (single-employee pilot)", () => {
    const withSection = resolveMcpServers({ browser: { enabled: false } }, emp({ jinnMcp: true }), "codex");
    expect(withSection.mcpServers).toHaveProperty("jinn");
    const noSection = resolveMcpServers(undefined, emp({ jinnMcp: true }), "codex");
    expect(Object.keys(noSection.mcpServers)).toEqual(["jinn"]);
    // The spec is the real builtin (entry + non-secret env), not a stub.
    const jinn = noSection.mcpServers.jinn as { command: string; args: string[]; env?: Record<string, string> };
    expect(jinn.command).toBe(process.execPath);
    expect(jinn.args[0]).toMatch(/server-entry\.js$/);
    expect(typeof jinn.env?.JINN_HOME).toBe("string");
  });

  it("force-on beats mcp:false — the employee gets ONLY jinn", () => {
    const r = resolveMcpServers(
      { browser: { enabled: false }, fetch: { enabled: true }, gateway: { enabled: true } } as McpGlobalConfig,
      emp({ jinnMcp: true, mcp: false }),
      "codex",
    );
    expect(Object.keys(r.mcpServers)).toEqual(["jinn"]);
  });

  it("force-on beats a jinn-less allowlist — allowlisted servers AND jinn", () => {
    const r = resolveMcpServers(
      { browser: { enabled: false }, fetch: { enabled: true }, gateway: { enabled: true } } as McpGlobalConfig,
      emp({ jinnMcp: true, mcp: ["fetch"] }),
      "codex",
    );
    expect(r.mcpServers).toHaveProperty("fetch");
    expect(r.mcpServers).toHaveProperty("jinn");
  });

  it("force-off detaches ONLY jinn when the master is on", () => {
    const r = resolveMcpServers(
      { browser: { enabled: false }, fetch: { enabled: true }, gateway: { enabled: true } } as McpGlobalConfig,
      emp({ jinnMcp: false }),
      "codex",
    );
    expect(r.mcpServers).not.toHaveProperty("jinn");
    expect(r.mcpServers).toHaveProperty("fetch");
  });
});

describe("resolveMcpServers — the smoke gate degrades attachment", () => {
  it("gate failed → no jinn anywhere (master on, force-on); other servers unaffected; gate ok → attach again", () => {
    setJinnAttachGate({ ok: false, reason: "authed smoke test got 401" });
    const cfg = { browser: { enabled: false }, fetch: { enabled: true }, gateway: { enabled: true } } as McpGlobalConfig;
    const r = resolveMcpServers(cfg, emp(), "codex");
    expect(r.mcpServers).not.toHaveProperty("jinn");
    expect(r.mcpServers).toHaveProperty("fetch");
    expect(resolveMcpServers(cfg, emp({ jinnMcp: true }), "codex").mcpServers).not.toHaveProperty("jinn");
    setJinnAttachGate({ ok: true });
    expect(resolveMcpServers(cfg, emp(), "codex").mcpServers).toHaveProperty("jinn");
  });

  it("GRS-017e-fix: an UNARMED gate fails closed through the resolver too — no jinn until a probe verifies the gateway", () => {
    setJinnAttachGate(null);
    const cfg = { browser: { enabled: false }, fetch: { enabled: true }, gateway: { enabled: true } } as McpGlobalConfig;
    const r = resolveMcpServers(cfg, emp(), "codex");
    expect(r.mcpServers).not.toHaveProperty("jinn");
    expect(r.mcpServers).toHaveProperty("fetch");
    // The pilot path is equally closed while unarmed (finding 1).
    expect(resolveMcpServers(undefined, emp({ jinnMcp: true }), "codex").mcpServers).toEqual({});
  });
});
