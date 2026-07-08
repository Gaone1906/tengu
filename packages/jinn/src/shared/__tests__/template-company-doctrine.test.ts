import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readTemplate(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), "template", rel), "utf-8");
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
});
