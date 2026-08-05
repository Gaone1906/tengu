import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContext } from "../context.js";
import type { Employee, JinnConfig, OrgHierarchy } from "../../shared/types.js";

// These tests lock the CURRENT output of buildContext after the "context hygiene"
// refactor: the static COO operating-manual base was dropped (engines auto-ingest
// CLAUDE.md/AGENTS.md), buildDelegationProtocol was deleted, the COO identity is a
// slim 3-line anchor, and the self-evolution block is onboarding-only.

const baseOpts = {
  source: "slack",
  channel: "C123",
  user: "Alex",
};

const minimalEmployee: Employee = {
  name: "content-lead",
  displayName: "Content Lead",
  department: "content",
  rank: "manager",
  engine: "claude",
  model: "opus",
  persona: "You lead the content team.",
};

describe("buildContext — COO (no employee)", () => {
  it("emits the slim COO identity anchor and points at the operating manual", () => {
    const out = buildContext({ ...baseOpts });
    // Slim 3-line identity anchor (default portalName = "Jinn")
    expect(out).toContain("# You are Jinn");
    expect(out).toContain("COO of the user's AI organization");
    // Anchor points at the auto-loaded manual rather than duplicating it
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("AGENTS.md");
  });

  it("includes the Current session section", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).toContain("## Current session");
  });

  it("does NOT inline the removed static operating manual / delegation protocol", () => {
    const out = buildContext({ ...baseOpts });
    // The long static base prose is gone — these markers must not appear.
    expect(out).not.toContain("Core Principles");
    expect(out).not.toContain("Delegation protocol");
    expect(out).not.toContain("## Delegation");
  });

  it("does not emit the employee identity section in COO mode", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).not.toContain("You are an AI employee in the");
    expect(out).not.toContain("## Your persona");
  });
});

describe("buildContext — employee mode", () => {
  it("emits the employee identity section instead of the COO anchor", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee });
    expect(out).toContain("# You are Content Lead");
    expect(out).toContain("You are an AI employee in the Jinn gateway system.");
    expect(out).toContain("## Your persona");
    expect(out).toContain("You lead the content team.");
    // The employee section carries the role block, not the COO "manual" anchor.
    expect(out).toContain("**Department**: content");
    expect(out).toContain("**Rank**: manager");
    // The COO-only anchor wording must NOT appear for an employee.
    expect(out).not.toContain("COO of the user's AI organization");
  });
});

describe("buildContext — Current session reflects passed opts", () => {
  it("reflects sessionId, channel and user", () => {
    const out = buildContext({
      ...baseOpts,
      sessionId: "sess-abc-123",
      user: "Operator Bob",
    });
    expect(out).toContain("- Session ID: sess-abc-123");
    expect(out).toContain("- User: Operator Bob");
    expect(out).toContain("C123");
  });

  it("renders a named channel when channelName is provided", () => {
    const out = buildContext({
      ...baseOpts,
      channel: "C999",
      channelName: "ventures",
    });
    expect(out).toContain("- Channel: #ventures (C999)");
  });

  it("labels a slack DM channel", () => {
    const out = buildContext({
      ...baseOpts,
      source: "slack",
      channel: "D456",
    });
    expect(out).toContain("- Channel: Direct Message (D456)");
  });
});

describe("buildContext — config awareness", () => {
  it("emits the configuration section reflecting the passed config", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: { default: "claude", claude: { model: "opus" } },
    } as unknown as JinnConfig;
    const out = buildContext({ ...baseOpts, config });
    expect(out).toContain("## Current configuration");
    expect(out).toContain("- Default engine: claude");
    expect(out).toContain("http://127.0.0.1:7799");
  });

  it("includes the active session's resolved engine, model, and effort", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: { default: "claude", claude: { model: "configured-opus" }, codex: { model: "configured-codex" } },
      logging: { level: "info" },
    } as unknown as JinnConfig;
    const out = buildContext({
      ...baseOpts,
      config,
      engine: "codex",
      model: "resolved-codex",
      effortLevel: "high",
    } as Parameters<typeof buildContext>[0] & { model: string; effortLevel: string });

    expect(out).toContain("- Active engine: codex");
    expect(out).toContain("- Active model: resolved-codex");
    expect(out).toContain("- Active effort: high");
  });

  it("preserves implicit configured model defaults and normalizes an empty log level", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: {
        default: "antigravity",
        claude: { model: "opus" },
        codex: { model: "gpt-5.5" },
        antigravity: {},
        grok: {},
      },
      logging: { level: "" },
    } as unknown as JinnConfig;

    const out = buildContext({ ...baseOpts, config });

    expect(out).toContain("- Antigravity model: Gemini 3.5 Flash (Medium)");
    expect(out).toContain("- Grok model: grok-build");
    expect(out).toContain("- Log level: info");
  });

  it("omits the configuration section when no config is passed", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).not.toContain("## Current configuration");
  });
});

describe("buildContext — Jinn MCP usage directive", () => {
  const director: Employee = {
    ...minimalEmployee,
    name: "ops-director",
    displayName: "Ops Director",
    department: "operations",
    rank: "manager",
  };
  const qa: Employee = {
    ...minimalEmployee,
    name: "qa-engineer",
    displayName: "QA Engineer",
    department: "quality",
    rank: "senior",
    engine: "codex",
    model: "gpt-5.5",
  };
  const junior: Employee = {
    ...minimalEmployee,
    name: "junior-qa",
    displayName: "Junior QA",
    department: "quality",
    rank: "employee",
  };
  const hierarchy = {
    root: "ops-director",
    nodes: {
      "ops-director": { employee: director, parentName: null, directReports: ["qa-engineer"], depth: 0, chain: [] },
      "qa-engineer": { employee: qa, parentName: "ops-director", directReports: ["junior-qa"], depth: 1, chain: ["ops-director"] },
      "junior-qa": { employee: junior, parentName: "qa-engineer", directReports: [], depth: 2, chain: ["ops-director", "qa-engineer"] },
    },
    sorted: ["ops-director", "qa-engineer", "junior-qa"],
    warnings: [],
  };

  it("announces the attached Jinn MCP and points task tracking at Todos/work-items for COO sessions", () => {
    const out = buildContext({ ...baseOpts, engine: "codex", jinnMcpAttached: true });

    expect(out).toContain("## COO Company Anchor");
    expect(out).toContain("Your `codex` engine has the built-in `jinn` MCP attached for this session.");
    expect(out).toContain("Todos/work-items are the source of truth for task tracking");
    expect(out).toContain("Use Workflows for multi-step or scheduled orchestration");
    expect(out).toContain("Use company-reference reads before asking the operator");
    expect(out).toContain("role/persona matches the task");
    expect(out).not.toContain("## Company Identity");
  });

  it("MCP-attached sessions use typed tools for chat attachments and connector delivery", () => {
    const out = buildContext({
      ...baseOpts,
      employee: qa,
      hierarchy,
      connectors: ["slack"],
      config: { gateway: { host: "127.0.0.1", port: 7777 }, engines: { default: "codex" } } as unknown as JinnConfig,
      jinnMcpAttached: true,
    });

    expect(out).toContain("Your hands are the attached Jinn MCP");
    expect(out).toContain("Local shell/filesystem access remains available for implementation work");
    expect(out).toContain("publish_attachment");
    expect(out).toContain("Viewing a file yourself does not send it to the operator");
    expect(out).toContain("send_connector_message");
    expect(out).not.toContain("curl -X POST");
    expect(out).not.toContain("curl POST");
    expect(out).not.toContain("JINN_GATEWAY_TOKEN");
    expect(out).not.toContain("/api/connectors");
    expect(out).not.toContain("/api/sessions");
    expect(out).not.toContain("board.json");
    expect(out).not.toContain("Create new employees by writing YAML");
    expect(out).not.toContain("editing YAML");
    expect(out).not.toContain("hand-editing roster files");
    expect(out).not.toContain("~/.jinn/org/");
    expect(out).not.toContain("config.yaml changes");
    expect(out).not.toContain("cron/jobs.json changes");
    expect(out).not.toContain("org/` changes");
  });

  it("non-MCP sessions retain operational YAML/roster guidance", () => {
    const out = buildContext({
      ...baseOpts,
      employee: qa,
      hierarchy,
      connectors: ["slack"],
      config: { gateway: { host: "127.0.0.1", port: 7777 }, engines: { default: "codex" } } as unknown as JinnConfig,
    });

    expect(out).toContain("editing YAML");
    expect(out).toContain("hand-editing roster files");
    expect(out).toContain("~/.jinn/org/");
  });

  it("does not announce Jinn MCP tools to sessions without the built-in server attached", () => {
    const out = buildContext({ ...baseOpts, engine: "codex" });

    expect(out).not.toContain("## COO Company Anchor");
    expect(out).not.toContain("## Company Identity");
    expect(out).not.toContain("built-in `jinn` MCP attached");
  });

  it("emits company operating doctrine without repeating employee identity", () => {
    const out = buildContext({ ...baseOpts, employee: qa, hierarchy, jinnMcpAttached: true });
    const companyBlock = out.slice(out.indexOf("## Company Identity"), out.indexOf("\n## ", out.indexOf("## Company Identity") + 3));

    expect(out).toContain("## Company Identity");
    expect(companyBlock).not.toContain("You are QA Engineer");
    expect(companyBlock).not.toContain("You report to Ops Director");
    expect(out).toContain("Your hands are the attached Jinn MCP");
    expect(out).toContain("Todos are your live work ledger");
    expect(out).toContain("Workflows are reusable automations (the HOW)");
    expect(out).toContain("Todos and Workflows are SEPARATE");
    expect(out).toContain("One employee may run multiple child sessions");
    expect(out).toContain("Questions and approvals route to your manager/COO by default");
    expect(out).toContain("aCEO/operator is the exception");
    expect(out).not.toContain("## COO Company Anchor");
    expect(out).not.toContain("Use it extensively before asking the operator or carrying state in prose.");
  });

  it("does not emit the company identity block for employee sessions without Jinn MCP attached", () => {
    const out = buildContext({ ...baseOpts, employee: qa, hierarchy });

    expect(out).not.toContain("## Company Identity");
    expect(out).not.toContain("Your hands are the attached Jinn MCP");
    expect(out).not.toContain("Todos are your live work ledger");
  });
});

describe("buildContext — onboarding block is omitted when portal setup is complete", () => {
  // Gate is portal.setupComplete === true, with portal.onboarded === true accepted for legacy wizard completions.
  const minConfig = {
    gateway: { host: "127.0.0.1", port: 7799 },
    engines: { default: "claude" },
    portal: { setupComplete: true },
  } as unknown as JinnConfig;

  it("does not emit the onboarding block when portal.setupComplete is true", () => {
    const out = buildContext({ ...baseOpts, config: minConfig });
    expect(out).not.toContain("## Onboarding mode");
  });

  it("does not emit the onboarding block for legacy configs with portal.onboarded true", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: { default: "claude" },
      portal: { onboarded: true },
    } as unknown as JinnConfig;
    const out = buildContext({ ...baseOpts, config });
    expect(out).not.toContain("## Onboarding mode");
  });

  it("never emits onboarding in employee mode", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee });
    expect(out).not.toContain("## Onboarding mode");
  });
});

describe("buildContext — onboarding block appears when portal.setupComplete is not set", () => {
  // When config is absent or both setupComplete/onboarded are falsy, the operator-aware onboarding directive is injected.
  it("emits onboarding block when portal.setupComplete is not set", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).toContain("## Onboarding mode");
    expect(out).toMatch(/fresh .* install|NOT yet completed onboarding/i);
  });

  it("omits onboarding block when portal.setupComplete is true", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: { default: "claude" },
      portal: { setupComplete: true },
    } as unknown as JinnConfig;
    const out = buildContext({ ...baseOpts, config });
    expect(out).not.toContain("## Onboarding mode");
  });
});

describe("buildContext — compact org roster", () => {
  const emp = (name: string, rank: Employee["rank"], persona: string): Employee => ({
    name, displayName: name, department: "eng", rank, engine: "claude", model: "opus", persona,
  });
  const hierarchy = {
    nodes: {
      lead: { employee: emp("lead", "manager", "You are the engineering lead.\nSecret persona preview text"), parentName: null, directReports: ["dev"], depth: 0, chain: [] },
      dev: { employee: emp("dev", "employee", "You are an implementation specialist.\nAnother secret persona"), parentName: "lead", directReports: [], depth: 1, chain: ["lead"] },
    },
    sorted: ["lead", "dev"],
  } as any;

  it("lists the compact first-line role but NOT the rest of each persona", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("## Organization (2 employee(s))");
    expect(out).toContain("- **lead** (lead) — eng, manager");
    expect(out).toContain("`lead` — engineering lead · eng · claude");
    expect(out).not.toContain("Secret persona preview");
    expect(out).not.toContain("Another secret persona");
  });

  it("points at the employee-detail endpoint for full personas", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("GET /api/org/employees/:name");
    expect(out).toContain("Create new employees by writing YAML files there");
    expect(out).toContain("the YAML under");
  });
});

describe("buildContext — audience scoping", () => {
  const worker: Employee = { ...minimalEmployee, name: "writer", displayName: "Writer", rank: "employee" };
  const hierarchy = {
    nodes: {
      "content-lead": { employee: minimalEmployee, parentName: null, directReports: ["writer"], depth: 0, chain: [] },
      writer: { employee: worker, parentName: "content-lead", directReports: [], depth: 1, chain: ["content-lead"] },
    },
    sorted: ["content-lead", "writer"],
  } as any;

  it("employee sessions get NO org roster and NO cron list", () => {
    const out = buildContext({ ...baseOpts, employee: worker, hierarchy });
    expect(out).not.toContain("## Organization");
    expect(out).not.toContain("## Scheduled cron");
    // Chain of command (their slice of the org) stays.
    expect(out).toContain("## Chain of command");
  });

  it("COO sessions still get the org roster", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("## Organization (2 employee(s))");
  });

  it("COO API section is a pointer at CLAUDE.md, not the full table", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).toContain("Gateway API");
    expect(out).not.toContain("| `/api/cron` | GET |"); // table rows gone
    expect(out).toContain("CLAUDE.md");
  });

  it("manager employees get the delegation mini-reference", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee, hierarchy });
    expect(out).toContain("Delegate to another employee");
    expect(out).toContain("/api/sessions/:id/message");
    expect(out).toContain("/attachments");
    expect(out).not.toContain("| `/api/cron` | GET |");
  });

  it("non-manager employees get attachments only — no delegation endpoints", () => {
    const out = buildContext({ ...baseOpts, employee: worker, hierarchy });
    expect(out).toContain("/attachments");
    expect(out).not.toContain("Delegate to another employee");
  });

  it("connector section is slim — recipe details live in CLAUDE.md", () => {
    const out = buildContext({ ...baseOpts, connectors: ["slack"] });
    expect(out).toContain("## Available connectors: slack");
    expect(out).toContain("/api/connectors/<id>/send");
    // The old per-connector recipe block is gone:
    expect(out).not.toContain("**Send threaded reply**");
  });

  it("senior WITHOUT reports gets no delegation mini-ref", () => {
    const senior: Employee = { ...minimalEmployee, name: "analyst", displayName: "Analyst", rank: "senior" };
    const out = buildContext({ ...baseOpts, employee: senior, hierarchy });
    expect(out).not.toContain("Delegate to another employee");
  });

  it("senior WITH direct reports gets the delegation mini-ref", () => {
    const seniorLead: Employee = { ...minimalEmployee, name: "ventures-lead", displayName: "Ventures Lead", rank: "senior" };
    const h = {
      nodes: {
        "ventures-lead": { employee: seniorLead, parentName: null, directReports: ["scout"], depth: 0, chain: [] },
        scout: { employee: { ...minimalEmployee, name: "scout", displayName: "Scout", rank: "employee" }, parentName: "ventures-lead", directReports: [], depth: 1, chain: ["ventures-lead"] },
      },
      sorted: ["ventures-lead", "scout"],
    } as any;
    const out = buildContext({ ...baseOpts, employee: seniorLead, hierarchy: h });
    expect(out).toContain("Delegate to another employee");
  });

  it("chain of command carries slugs for delegation", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee, hierarchy });
    expect(out).toContain("`writer`"); // direct report slug
  });
});

describe("buildContext — scoped working roster", () => {
  const employee = (
    name: string,
    options: Partial<Employee> & { role: string },
  ): Employee => ({
    name,
    displayName: options.displayName ?? name,
    department: options.department ?? "platform",
    rank: options.rank ?? "employee",
    engine: options.engine ?? "codex",
    model: options.model ?? "test-model",
    persona: `You are the ${options.role}.\nHidden operating procedure for ${name}.`,
    reportsTo: options.reportsTo,
  });

  const hierarchy = (employees: Employee[], parents: Record<string, string | null>): OrgHierarchy => {
    const nodes: OrgHierarchy["nodes"] = {};
    for (const member of employees) {
      const parentName = parents[member.name] ?? null;
      nodes[member.name] = {
        employee: member,
        parentName,
        directReports: [],
        depth: parentName ? 1 : 0,
        chain: parentName ? [parentName, member.name] : [member.name],
      };
    }
    for (const [name, node] of Object.entries(nodes)) {
      if (node.parentName && nodes[node.parentName]) nodes[node.parentName].directReports.push(name);
    }
    return { root: null, nodes, sorted: employees.map((member) => member.name), warnings: [] };
  };

  const workingRoster = (context: string): string => {
    const marker = "## Working roster (scoped orientation; not exhaustive)";
    const start = context.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = context.indexOf("\n## ", start + marker.length);
    return context.slice(start, end < 0 ? undefined : end);
  };

  it("gives the COO every top-level routing lane with compact roles, departments, and engines", () => {
    const roots = Array.from({ length: 18 }, (_, index) => employee(`lane-${index + 1}`, {
      role: `routing lead for lane ${index + 1}`,
      department: `department-${index + 1}`,
      rank: "manager",
      engine: index % 2 === 0 ? "codex" : "claude",
    }));
    const nested = employee("nested-specialist", { role: "deep specialist", reportsTo: "lane-1" });
    const org = hierarchy([...roots, nested], {
      ...Object.fromEntries(roots.map((root) => [root.name, null])),
      "nested-specialist": "lane-1",
    });

    const roster = workingRoster(buildContext({ ...baseOpts, hierarchy: org, jinnMcpAttached: true }));

    for (const [index, root] of roots.entries()) {
      expect(roster).toContain(
        `- \`${root.name}\` — routing lead for lane ${index + 1} · department-${index + 1} · ${root.engine}`,
      );
    }
    expect(roster).not.toContain("nested-specialist");
    expect(roster).not.toContain("Hidden operating procedure");
    expect(roster).toContain("find_employees");
    expect(roster).toContain("list_employees");
    expect(roster).toContain("get_employee");
  });

  it("recommends org MCP tools only when the Jinn MCP is attached", () => {
    const lead = employee("platform-lead", {
      role: "platform delivery",
      rank: "manager",
    });
    const org = hierarchy([lead], { "platform-lead": null });

    const withoutMcp = buildContext({ ...baseOpts, hierarchy: org, jinnMcpAttached: false });
    const withoutMcpRoster = workingRoster(withoutMcp);
    expect(withoutMcpRoster).toContain("`platform-lead` — platform delivery · platform · codex");
    expect(withoutMcp).not.toContain("find_employees");
    expect(withoutMcp).not.toContain("list_employees");
    expect(withoutMcp).not.toContain("get_employee");

    const withMcp = buildContext({ ...baseOpts, hierarchy: org, jinnMcpAttached: true });
    const withMcpRoster = workingRoster(withMcp);
    expect(withMcpRoster).toContain("`platform-lead` — platform delivery · platform · codex");
    expect(withMcpRoster).toContain("find_employees");
    expect(withMcpRoster).toContain("list_employees");
    expect(withMcpRoster).toContain("get_employee");
  });

  it("gives a report-holder its manager, direct reports, and same-manager peers only", () => {
    const chief = employee("company-chief", { role: "company coordination", rank: "executive", department: "company" });
    const lead = employee("platform-lead", { role: "platform delivery", rank: "senior", reportsTo: "company-chief" });
    const peer = employee("design-lead", { role: "product design", rank: "manager", department: "design", reportsTo: "company-chief" });
    const peerIc = employee("operations-peer", { role: "operational planning", department: "operations", reportsTo: "company-chief" });
    const developer = employee("platform-developer", { role: "gateway engineering", reportsTo: "platform-lead" });
    const qa = employee("platform-qa", { role: "release verification", department: "quality", reportsTo: "platform-lead" });
    const cousin = employee("design-ic", { role: "interface implementation", department: "design", reportsTo: "design-lead" });
    const unrelated = employee("independent-root", { role: "independent research", department: "research" });
    const org = hierarchy([chief, lead, peer, peerIc, developer, qa, cousin, unrelated], {
      "company-chief": null,
      "platform-lead": "company-chief",
      "design-lead": "company-chief",
      "operations-peer": "company-chief",
      "platform-developer": "platform-lead",
      "platform-qa": "platform-lead",
      "design-ic": "design-lead",
      "independent-root": null,
    });

    const roster = workingRoster(buildContext({ ...baseOpts, employee: lead, hierarchy: org, jinnMcpAttached: true }));

    expect(roster).toContain("Your manager:");
    expect(roster).toContain("`company-chief` — company coordination · company");
    expect(roster).toContain("Your direct reports:");
    expect(roster).toContain("`platform-developer` — gateway engineering · platform");
    expect(roster).toContain("`platform-qa` — release verification · quality");
    expect(roster).toContain("Your peers:");
    expect(roster).toContain("`design-lead` — product design · design");
    expect(roster).toContain("`operations-peer` — operational planning · operations");
    expect(roster).not.toContain("platform-lead");
    expect(roster).not.toContain("design-ic");
    expect(roster).not.toContain("independent-root");
  });

  it("gives an IC its manager and same-manager siblings without the wider org", () => {
    const chief = employee("company-chief", { role: "company coordination", rank: "executive", department: "company" });
    const lead = employee("platform-lead", { role: "platform delivery", rank: "manager", reportsTo: "company-chief" });
    const developer = employee("platform-developer", { role: "gateway engineering", reportsTo: "platform-lead" });
    const qa = employee("platform-qa", { role: "release verification", department: "quality", reportsTo: "platform-lead" });
    const operator = employee("runtime-operator", { role: "runtime operations", reportsTo: "platform-lead" });
    const peerLead = employee("design-lead", { role: "product design", rank: "manager", department: "design", reportsTo: "company-chief" });
    const org = hierarchy([chief, lead, developer, qa, operator, peerLead], {
      "company-chief": null,
      "platform-lead": "company-chief",
      "platform-developer": "platform-lead",
      "platform-qa": "platform-lead",
      "runtime-operator": "platform-lead",
      "design-lead": "company-chief",
    });

    const roster = workingRoster(buildContext({ ...baseOpts, employee: developer, hierarchy: org, jinnMcpAttached: true }));

    expect(roster).toContain("Your manager:");
    expect(roster).toContain("`platform-lead` — platform delivery · platform");
    expect(roster).toContain("Your siblings:");
    expect(roster).toContain("`platform-qa` — release verification · quality");
    expect(roster).toContain("`runtime-operator` — runtime operations · platform");
    expect(roster).not.toContain("platform-developer");
    expect(roster).not.toContain("company-chief");
    expect(roster).not.toContain("design-lead");
  });

  it("caps each audience slice and keeps the injected roster token-small", () => {
    const roots = Array.from({ length: 30 }, (_, index) => employee(`root-${index + 1}`, {
      role: `routing lane ${index + 1}`,
      department: `department-${index + 1}`,
      rank: "manager",
    }));
    const cooOrg = hierarchy(roots, Object.fromEntries(roots.map((root) => [root.name, null])));
    const cooRoster = workingRoster(buildContext({ ...baseOpts, hierarchy: cooOrg, jinnMcpAttached: true }));
    const cooRows = cooRoster.match(/^- `/gm) ?? [];

    expect(cooRows).toHaveLength(20);
    expect(cooRoster).toContain("+10 more");
    expect(Math.ceil(cooRoster.length / 4)).toBeLessThan(600);

    const manager = employee("manager", { role: "team leadership", rank: "manager" });
    const siblings = Array.from({ length: 20 }, (_, index) => employee(`sibling-${index + 1}`, {
      role: `specialist ${index + 1}`,
      reportsTo: "manager",
    }));
    const current = employee("current-ic", { role: "current specialist", reportsTo: "manager" });
    const icOrg = hierarchy([manager, current, ...siblings], {
      manager: null,
      "current-ic": "manager",
      ...Object.fromEntries(siblings.map((sibling) => [sibling.name, "manager"])),
    });
    const icRoster = workingRoster(buildContext({ ...baseOpts, employee: current, hierarchy: icOrg, jinnMcpAttached: true }));
    const icRows = icRoster.match(/^- `/gm) ?? [];

    expect(icRows).toHaveLength(9); // manager + eight siblings
    expect(icRoster).toContain("+12 more");
    expect(Math.ceil(icRoster.length / 4)).toBeLessThan(300);
  });
});

describe("buildContext — maxChars trimming", () => {
  it("strictly bounds an oversized employee context to configured maxChars", () => {
    const cap = 1200;
    const config = {
      gateway: { host: "127.0.0.1", port: 7777 },
      engines: { default: "claude", claude: { model: "opus" } },
      context: { maxChars: cap },
    } as unknown as JinnConfig;
    const oversizedEmployee: Employee = {
      ...minimalEmployee,
      name: "oversized-employee",
      displayName: "Oversized Employee",
      rank: "employee",
      reportsTo: "safety-manager",
      persona: [
        "You own a high-volume content pipeline.",
        "You coordinate approval workflows across the publishing team.",
        "SAFETY: Never publish externally without manager approval.",
        "DO NOT expose credentials in generated content.",
        "Detailed operating procedure. ".repeat(1000),
      ].join("\n"),
    };
    const manager: Employee = {
      ...minimalEmployee,
      name: "safety-manager",
      displayName: "Safety Manager",
      persona: "You manage safety-sensitive publishing.",
    };
    const hierarchy: OrgHierarchy = {
      root: null,
      sorted: [manager.name, oversizedEmployee.name],
      warnings: [],
      nodes: {
        [manager.name]: {
          employee: manager,
          parentName: null,
          directReports: [oversizedEmployee.name],
          depth: 0,
          chain: [manager.name],
        },
        [oversizedEmployee.name]: {
          employee: oversizedEmployee,
          parentName: manager.name,
          directReports: [],
          depth: 1,
          chain: [manager.name, oversizedEmployee.name],
        },
      },
    };
    const out = buildContext({
      ...baseOpts,
      config,
      employee: oversizedEmployee,
      hierarchy,
      connectors: ["slack"],
      jinnMcpAttached: true,
    });
    expect(out.length).toBeLessThanOrEqual(cap);
    expect(out).toContain("# You are Oversized Employee");
    expect(out).toContain("## Current session");
    expect(out).toContain("## Company Identity");
    expect(out).toContain("## Working roster (scoped orientation; not exhaustive)");
    expect(out).toContain("Safety Manager");
    expect(out).toContain("Use the attached Jinn MCP");
    expect(out).toContain("SAFETY: Never publish externally without manager approval.");
    expect(out).toContain("DO NOT expose credentials in generated content.");
    expect(out).not.toContain("You coordinate approval workflows");
  });

  it("does not trim when output is under the default cap", () => {
    const out = buildContext({ ...baseOpts });
    expect(out.length).toBeLessThan(100_000);
    // Essential sections present and intact.
    expect(out).toContain("# You are Jinn");
    expect(out).toContain("## Current session");
  });
});

describe("buildContext — local discovery diet", () => {
  it("does not dump tool-directory contents or project names into every prompt", () => {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-context-home-"));
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "private-state.json"), "{}");
    fs.mkdirSync(path.join(home, "Projects", "private-project"), { recursive: true });
    process.env.HOME = home;

    try {
      const out = buildContext({ ...baseOpts });
      expect(out).toContain("## Local environment");
      expect(out).toContain("inspect them on demand");
      expect(out).not.toContain("Contents:");
      expect(out).not.toContain("private-state.json");
      expect(out).not.toContain("private-project");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
