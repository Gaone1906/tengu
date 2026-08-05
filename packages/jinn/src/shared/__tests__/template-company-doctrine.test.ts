import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

function readTemplate(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), "template", rel), "utf-8");
}

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), "..", "..", rel), "utf-8");
}

function readPackage(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
}

function activeTemplateFiles(): string[] {
  const root = path.join(process.cwd(), "template");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "migrations") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else files.push(entryPath);
    }
  };
  visit(root);
  return files.sort();
}

function lineCount(content: string): number {
  return content.trimEnd().split(/\r?\n/).length;
}

function skillInventory(content: string): string[] {
  return [...content.matchAll(/^- \*\*([a-z0-9-]+)\*\*:/gm)].map((match) => match[1]).sort();
}

describe("template company doctrine", () => {
  it("ships the seven locked company-doctrine headings", () => {
    const doctrine = readTemplate("docs/company-doctrine.md");
    const headings = [
      "## 1. KISS/Minecraft",
      "## 2. The Company Metaphor Is the API",
      "## 3. Anti-Bottleneck",
      "## 4. One Interface (MCP)",
      "## 5. Uniform Contracts",
      "## 6. Lean Identity Context",
      "## 7. Contextual Relevance / Progressive Disclosure",
    ];

    for (const heading of headings) expect(doctrine).toContain(heading);
  });

  it("enforces the Workflow/Todo contract on each active template surface", () => {
    const surfaces = [
      {
        rel: "CLAUDE.md",
        required: [
          "A Workflow invocation never creates, links, transitions, approves, or mutates a Todo.",
          "A Todo-status trigger is a one-way input; the resulting Workflow run is independent.",
          "Workflow runs are durable records, not Sessions.",
        ],
      },
      {
        rel: "docs/company-doctrine.md",
        required: [
          "A Workflow invocation never creates, links, transitions, approves, or mutates a Todo.",
          "A Todo-status trigger is a one-way input; the resulting Workflow run is independent.",
          "Workflow runs are durable records, not Sessions.",
        ],
      },
      {
        rel: "docs/org.md",
        required: [
          "A Workflow invocation never creates, links, transitions, approves, or mutates a Todo.",
          "A Todo-status trigger is a one-way input; the resulting Workflow run is independent.",
          "Workflow runs are durable records, not Sessions.",
        ],
      },
      {
        rel: "skills/todo-handling/SKILL.md",
        required: [
          "A Workflow invocation never creates, links, transitions, approves, or mutates a Todo.",
          "Todo approvals affect only the Todo.",
          "Workflow operations never mutate Todos.",
        ],
      },
      {
        rel: "skills/workflow/SKILL.md",
        required: [
          "A Workflow invocation never creates, links, transitions, approves, or mutates a Todo.",
          "Workflow runs are durable records, not Sessions.",
          "cancel_workflow_run",
          "decide_workflow_approval",
        ],
      },
    ];
    const staleCouplingGuidance = [
      "mirrored workflow",
      "run's Todo",
      "Todo that records each live run",
      "workflow runs are entered automatically",
      "todoTransition",
    ];

    for (const surface of surfaces) {
      const content = readTemplate(surface.rel);
      for (const principle of surface.required) expect(content, `${surface.rel}: ${principle}`).toContain(principle);
      for (const stale of staleCouplingGuidance) {
        expect(content.toLowerCase(), `${surface.rel}: ${stale}`).not.toContain(stale.toLowerCase());
      }
    }
  });

  it("keeps active API and MCP provenance guidance on current producers, not Workflow bridges", () => {
    const activeGuidance = [
      { rel: "src/gateway/api.ts", content: readPackage("src/gateway/api.ts") },
      { rel: "src/mcp/work-item-tools.ts", content: readPackage("src/mcp/work-item-tools.ts") },
    ];

    for (const surface of activeGuidance) {
      expect(surface.rel).not.toContain("template/migrations/");
      expect(surface.content, surface.rel).toContain("cron and delegation create their own records");
      expect(surface.content, surface.rel).toContain("source=workflow is historical audit provenance and is not currently minted");
      expect(surface.content, surface.rel).not.toMatch(/cron\/workflow\/delegation source records are minted/i);
      expect(surface.content, surface.rel).not.toMatch(/dedicated bridges?/i);
    }
  });

  it("links the doctrine and keeps active template prose on Todos, not legacy task boards", () => {
    expect(readTemplate("CLAUDE.md")).toContain("docs/company-doctrine.md");
    expect(readTemplate("docs/overview.md")).toContain("company-doctrine.md");

    const currentTemplateFiles = [
      "CLAUDE.md",
      "docs/overview.md",
      "docs/org.md",
      "docs/cron.md",
      "docs/self-modification.md",
      "skills/management/SKILL.md",
      "skills/cron-manager/SKILL.md",
      "skills/self-heal/SKILL.md",
    ];
    for (const rel of currentTemplateFiles) {
      const content = readTemplate(rel);
      expect(content, rel).not.toMatch(/\bboards?\b/i);
      expect(content, rel).not.toContain("board.json");
      expect(content, rel).not.toContain("in_progress");
    }

    expect(readTemplate("CLAUDE.md")).toContain("manager/COO by default");
  });

  it("keeps the active operator template MCP-first for company operations", () => {
    const template = readTemplate("CLAUDE.md");

    expect(template).toContain("Use the attached Jinn MCP tools for company operations");
    expect(template).toContain("Local shell/filesystem work remains available for implementation tasks");
    expect(template).not.toContain('curl -X POST "$JINN_GATEWAY_URL"/api/sessions');
    expect(template).not.toContain("/api/connectors/<name>/send");
    expect(template).not.toContain("/api/sessions/<your-session-id>/attachments");
    expect(template).not.toContain("JINN_GATEWAY_TOKEN");
    expect(template).not.toContain("Employees are YAML persona files");
    expect(template).not.toContain("editing YAML");
    expect(template).not.toContain("hand-editing roster files");
    expect(template).not.toContain("~/.jinn/org/");
    expect(template).not.toContain("POST /api/sessions");
    expect(template).not.toContain("GET /api/sessions/{id}");
    expect(template).not.toContain("POST /api/sessions/{id}/message");
    expect(template).not.toContain("You can edit any file in `~/.jinn/`");
    expect(template).not.toContain("config.yaml changes");
    expect(template).not.toContain("cron/jobs.json changes");
    expect(template).not.toContain("org/` changes");
  });

  it("points each company concern to its owning compact playbook", () => {
    const template = readTemplate("CLAUDE.md");
    const owners = [
      ["Todos", "skills/todo-handling/SKILL.md"],
      ["Workflows", "skills/workflow/SKILL.md"],
      ["Delegation", "skills/delegation/SKILL.md"],
      ["Cron", "skills/cron-manager/SKILL.md"],
      ["Organization", "skills/management/SKILL.md"],
      ["Notes", "skills/notes/SKILL.md"],
      ["Experiments", "skills/experiments/SKILL.md"],
    ];

    for (const [concern, owner] of owners) {
      expect(template, concern).toContain(`| ${concern} | \`${owner}\` |`);
    }

    expect(template).not.toContain("### Cross-Department Services");
    expect(template).not.toContain("org/service tools");
    expect(template).not.toContain("menu of available services");
    expect(template).not.toContain("provides:");
  });

  it("ships exactly six public blocks and keeps Triggers a Workflow detail", () => {
    for (const rel of ["CLAUDE.md", "docs/company-doctrine.md", "docs/overview.md"]) {
      const content = readTemplate(rel);
      expect(content, rel).toContain("Employees, Todos, Workflows, Chats, Notes, and Experiments");
      expect(content, rel).not.toContain("Employees, Todos, Workflows, Triggers, and Notes");
    }
    const template = readTemplate("CLAUDE.md");
    const doctrine = readTemplate("docs/company-doctrine.md");
    const notesSkill = readTemplate("skills/notes/SKILL.md");
    expect(template).toContain("Triggers are a Workflow detail");
    expect(doctrine).toContain("Triggers are a Workflow detail");
    expect(notesSkill).toContain("read it before updating and pass its returned revision as expectedRevision");
    expect(notesSkill).toContain("`docs/` remains read-only");
  });

  it("ships compact delegation doctrine for nested callbacks and execution quality", () => {
    const template = readTemplate("CLAUDE.md");
    const delegation = readTemplate("skills/delegation/SKILL.md");
    const todoHandling = readTemplate("skills/todo-handling/SKILL.md");

    expect(delegation).toContain("use native sub-agents only for extra hands inside your own role");
    expect(delegation).toContain("Select by role and persona fit");
    expect(delegation).toContain("The child's reply wakes the parent session");
    expect(delegation).toContain("Delegate through the relevant manager");
    expect(delegation).toContain("the IC's manager is notified");
    expect(template).not.toContain("Agent teams for multi-phase tasks");
    expect(template).toContain("PLAN -> REFINE -> IMPLEMENT -> REVIEW -> VERIFY");
    expect(todoHandling).toContain("in_review");
    expect(delegation).toContain("at least two independent reviewers");
    expect(delegation).toContain("Managers and the COO should orchestrate, not implement");
    expect(delegation).toContain("explicit stop condition");
    expect(delegation).toContain("deadline/budget");
    expect(delegation).toContain("If an engine exposes a native goal loop");
    expect(delegation).toContain("THOROUGH for architecture, security, breaking, or irreversible work");
  });

  it("keeps shipped instruction surfaces lean and free of stale identifiers", () => {
    const files = activeTemplateFiles();
    const content = files.map((file) => fs.readFileSync(file, "utf-8")).join("\n");
    const canonicalEngines = "claude, codex, antigravity, grok, pi, hermes";

    expect(content).not.toContain("~/.{{portalSlug}}");
    expect(content).not.toMatch(/claude. or .codex/i);
    expect(content).not.toMatch(/\bo3\b/);

    for (const rel of [
      "docs/org.md",
      "docs/cron.md",
      "skills/management/SKILL.md",
      "skills/cron-manager/SKILL.md",
      "skills/self-heal/SKILL.md",
    ]) {
      expect(readTemplate(rel), rel).toContain(canonicalEngines);
    }

    const findAndInstall = readTemplate("skills/find-and-install/SKILL.md");
    expect(findAndInstall.match(/\$JINN_HOME/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(findAndInstall).toContain("defaults to `~/.jinn`");
    expect(readTemplate("skills/onboarding/SKILL.md")).toContain("`$JINN_HOME` (defaults to `~/.jinn`)");

    expect(lineCount(readTemplate("CLAUDE.md"))).toBeLessThanOrEqual(150);
    expect(lineCount(readTemplate("skills/management/SKILL.md"))).toBeLessThanOrEqual(120);
    expect(lineCount(readTemplate("skills/cron-manager/SKILL.md"))).toBeLessThanOrEqual(70);

    const workflow = readTemplate("skills/workflow/SKILL.md");
    expect(workflow).not.toMatch(/legacy-v1-import-report\.json|v1 import|active v1 runs|drain active v1/i);
  });

  it("lists every shipped skill exactly once on both discovery surfaces", () => {
    const directories = fs.readdirSync(path.join(process.cwd(), "template", "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillInventory(readTemplate("CLAUDE.md"))).toEqual(directories);
    expect(skillInventory(readTemplate("docs/skills.md"))).toEqual(directories);
  });

  it("only backticks registered snake_case MCP tool names", () => {
    const registered = new Set<string>();
    const mcpDirectory = path.join(process.cwd(), "src", "mcp");
    for (const entry of fs.readdirSync(mcpDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = fs.readFileSync(path.join(mcpDirectory, entry.name), "utf-8");
      for (const match of source.matchAll(/name:\s*"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g)) registered.add(match[1]);
    }

    const referenced = new Set<string>();
    for (const file of activeTemplateFiles()) {
      const content = fs.readFileSync(file, "utf-8");
      for (const match of content.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) referenced.add(match[1]);
    }

    expect([...referenced].filter((tool) => !registered.has(tool)).sort()).toEqual([]);
  });

  it("keeps shipped management/onboarding/sync skills on MCP tools, not raw gateway HTTP", () => {
    const skillFiles = [
      "skills/management/SKILL.md",
      "skills/onboarding/SKILL.md",
      "skills/sync/SKILL.md",
    ];

    for (const rel of skillFiles) {
      const content = readTemplate(rel);
      expect(content, rel).not.toMatch(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//);
      expect(content, rel).not.toMatch(/\bcurl\b.*\/api\//);
      expect(content, rel).not.toContain("gateway API");
      expect(content, rel).not.toContain("parentSessionId");
    }

    expect(readTemplate("skills/management/SKILL.md")).toContain("delegate_task");
    expect(readTemplate("skills/management/SKILL.md")).toContain("get_employee");
    expect(readTemplate("skills/cron-manager/SKILL.md")).toContain("list_cron_jobs");
    expect(readTemplate("skills/cron-manager/SKILL.md")).toContain("get_cron_run_history");
    expect(readTemplate("skills/onboarding/SKILL.md")).toContain("spawn_session");
    expect(readTemplate("skills/sync/SKILL.md")).toContain("list_sessions");
    expect(readTemplate("skills/sync/SKILL.md")).toContain("read_session");
  });

  it("ships discoverable MCP-first playbooks for core company operations", () => {
    const shipped = [
      {
        directory: "workflow",
        tools: [
          "list_workflows",
          "get_workflow",
          "create_workflow",
          "update_workflow",
          "enable_workflow",
          "start_workflow_run",
          "list_workflow_runs",
          "get_workflow_run",
          "decide_workflow_approval",
          "fire_workflow_event",
          "idempotencyKey",
          "PLAN",
          "IMPLEMENT",
          "VERIFY",
          "todo-status",
        ],
      },
      {
        directory: "todo-handling",
        tools: [
          "list_work_items",
          "search_work_items",
          "get_work_item",
          "create_work_item",
          "assign_work_item",
          "update_work_item",
          "archive_work_item",
          "request_work_item_approval",
          "decide_work_item_approval",
          "escalate_work_item_approval",
          "in_review",
          "blocked",
          "escalated",
        ],
      },
      {
        directory: "delegation",
        tools: [
          "list_employees",
          "find_employees",
          "get_employee",
          "delegate_task",
          "spawn_session",
          "send_to_session",
          "read_session",
          "stop_session",
          "idempotencyKey",
          "managed file IDs",
        ],
      },
      {
        directory: "notes",
        tools: [
          "list_notes",
          "read_note",
          "create_note",
          "update_note",
          "expectedRevision",
          "`knowledge/`",
          "`docs/` remains read-only",
        ],
      },
      {
        directory: "experiments",
        tools: [
          "list_experiments",
          "get_experiment",
          "create_experiment",
          "update_experiment",
          "conclude_experiment",
        ],
      },
    ];

    for (const { directory, tools } of shipped) {
      const rel = `skills/${directory}/SKILL.md`;
      const content = readTemplate(rel);
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
      expect(frontmatter, `${rel} frontmatter`).not.toBeNull();
      const metadata = parseYaml(frontmatter![1]) as Record<string, unknown>;
      expect(metadata.name, rel).toBe(directory);
      expect(typeof metadata.description, rel).toBe("string");
      expect(String(metadata.description).trim().length, rel).toBeGreaterThan(0);
      expect(content, rel).not.toMatch(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//);
      expect(content, rel).not.toMatch(/\bcurl\b.*\/api\//);
      expect(content, rel).not.toContain("gateway API");
      if (directory === "notes" || directory === "experiments") {
        expect(lineCount(content), rel).toBeLessThanOrEqual(80);
      }
      for (const expected of tools) expect(content, `${rel}: ${expected}`).toContain(expected);
    }

    const workflowSkill = readTemplate("skills/workflow/SKILL.md");
    expect(workflowSkill).toContain("Route unclear authority to the manager/COO");
    expect(workflowSkill).toContain("native pending approval on the run");

    const todoSkill = readTemplate("skills/todo-handling/SKILL.md");
    expect(todoSkill).toContain("One operator outcome should normally map to one root Todo.");
    expect(todoSkill).toContain("A checklist does not imply one Todo per item.");
    expect(todoSkill).toContain("Only independently assignable or independently reviewable deliverables become child Todos.");
    expect(todoSkill).toContain('"parentId": "ACM-42"');
    expect(todoSkill).toContain("get_work_item_tree");
    expect(todoSkill).toContain("rootsOnly");
    expect(todoSkill).toContain("identical pending request");
    expect(todoSkill).toContain("does not perform approval decisions");
    expect(todoSkill).toContain("Todo approvals affect only the Todo");
    expect(todoSkill).toContain("Workflow operations never mutate Todos");
    expect(todoSkill).not.toContain("Workflow gate");
    expect(todoSkill).not.toContain("cancel_workflow_run");
    expect(todoSkill).toContain("maxRounds");

    for (const [name, skill] of [["workflow", workflowSkill], ["todo-handling", todoSkill]] as const) {
      expect(skill, name).toContain("resolved routed owner");
      expect(skill, name).toContain("hierarchy root/COO is exempt");
      expect(skill, name).toContain("avoid approving work they personally executed");
      expect(skill, name).not.toContain("A worker or Todo owner cannot decide their own approval");
      expect(skill, name).not.toContain("A worker who owns or executed the Todo cannot decide their own approval");
    }

    const delegationSkill = readTemplate("skills/delegation/SKILL.md");
    expect(delegationSkill).toContain("never workspace or absolute paths");

    const setup = fs.readFileSync(path.join(process.cwd(), "src", "cli", "setup.ts"), "utf-8");
    expect(setup).toContain('copyTemplateDir(path.join(TEMPLATE_DIR, "skills"), SKILLS_DIR');
  });

  it("includes the pre-merge template staleness audit report", () => {
    const report = readRepo("docs/superpowers/specs/2026-07-08-template-doctrine-staleness-audit.md");

    expect(report).toContain("# Template Doctrine Staleness Audit");
    expect(report).toContain("Fix:");
    expect(report).toContain("Defer:");
    expect(report).toContain("skills/management/SKILL.md");
    expect(report).toContain("skills/onboarding/SKILL.md");
    expect(report).toContain("skills/sync/SKILL.md");
    expect(report).toContain("talk/card-reference.md");
  });
});
