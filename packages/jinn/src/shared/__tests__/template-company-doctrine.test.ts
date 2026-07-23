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

  it("teaches the complete company surface without obsolete service routing", () => {
    const template = readTemplate("CLAUDE.md");

    expect(template).toContain("### Todos");
    expect(template).toContain("### Workflows");
    expect(template).toContain("#### Triggers");
    expect(template).toContain("### Notes");
    expect(template).toContain("fire_workflow_event");
    expect(template).toContain("decide_workflow_approval");
    expect(template).toContain("list_notes");
    expect(template).toContain("read_note");
    expect(template).toContain("create_note");
    expect(template).toContain("update_note");
    expect(template).toContain("the IC's manager is notified");

    expect(template).not.toContain("### Cross-Department Services");
    expect(template).not.toContain("org/service tools");
    expect(template).not.toContain("menu of available services");
    expect(template).not.toContain("provides:");
  });

  it("ships exactly five public blocks and keeps Triggers a Workflow detail", () => {
    for (const rel of ["CLAUDE.md", "docs/company-doctrine.md", "docs/overview.md"]) {
      const content = readTemplate(rel);
      expect(content, rel).toContain("Employees, Todos, Workflows, Chats, and Notes");
      expect(content, rel).not.toContain("Employees, Todos, Workflows, Triggers, and Notes");
    }
    const template = readTemplate("CLAUDE.md");
    const doctrine = readTemplate("docs/company-doctrine.md");
    expect(template).toContain("Triggers are a Workflow detail");
    expect(doctrine).toContain("Triggers are a Workflow detail");
    expect(template).toContain("read it before updating and pass its returned revision as expectedRevision");
    expect(template).toContain("`docs/` remains read-only");
  });

  it("ships compact delegation doctrine for nested callbacks and execution quality", () => {
    const template = readTemplate("CLAUDE.md");

    expect(template).toContain("any session at any depth");
    expect(template).toContain("COO -> lead -> pod -> sub-report");
    expect(template).toContain("Employees =");
    expect(template).toContain("Sub-agents =");
    expect(template).toContain("different role -> employee; more hands for your own task -> sub-agents");
    expect(template).toContain("Select by fit");
    expect(template).not.toContain("Agent teams for multi-phase tasks");

    expect(template).toContain("PLAN -> REFINE -> IMPLEMENT -> REVIEW -> VERIFY");
    expect(template).toContain("at least two independent reviewers");
    expect(template).toContain("in_review");
    expect(template).toContain("Managers and the COO should orchestrate, not implement");
    expect(template).toContain("explicit, testable stop condition and a budget");
    expect(template).toContain("If an engine exposes a native goal loop");
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
    expect(readTemplate("skills/onboarding/SKILL.md")).toContain("spawn_session");
    expect(readTemplate("skills/sync/SKILL.md")).toContain("list_sessions");
    expect(readTemplate("skills/sync/SKILL.md")).toContain("read_session");
  });

  it("ships discoverable MCP-first playbooks for workflows, Todos, and delegation", () => {
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
      for (const expected of tools) expect(content, `${rel}: ${expected}`).toContain(expected);
    }

    const workflowSkill = readTemplate("skills/workflow/SKILL.md");
    expect(workflowSkill).toContain("Route unclear authority to the manager/COO");
    expect(workflowSkill).toContain("native pending approval on the run");

    const todoSkill = readTemplate("skills/todo-handling/SKILL.md");
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
