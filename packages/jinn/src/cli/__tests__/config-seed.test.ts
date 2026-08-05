import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { workflowNodeSchema } from "../../workflows/model.js";

// Resolve packages/jinn/ from this test file (…/src/cli/__tests__/) — never touch
// the real ~/.jinn; assert against the shipped sources statically.
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEMPLATE = join(PKG, "template");
const SETUP = join(PKG, "src", "cli", "setup.ts");
const WORKFLOW_TRIGGER_README = join(TEMPLATE, "scripts", "workflow-triggers", "README.md");

describe("fresh-install: template seeding + config guidance", () => {
  it("enables gateway authentication in the canonical fresh-install config", () => {
    const source = readFileSync(SETUP, "utf-8");
    expect(source).toMatch(/gateway:\n  port: 7777\n  host: "127\.0\.0\.1"\n  authRequired: true\n/);
  });

  it("does not ship or seed the retired Talk orchestrator templates", () => {
    const setupSource = readFileSync(SETUP, "utf-8");
    expect(existsSync(join(TEMPLATE, "talk", "orchestrator-persona.md"))).toBe(false);
    expect(existsSync(join(TEMPLATE, "talk", "card-reference.md"))).toBe(false);
    expect(setupSource).not.toMatch(/copyTemplateDir\(\s*path\.join\(TEMPLATE_DIR, ["']talk["']\)/);
  });

  it("seeds template/scripts/ into the home during setup", () => {
    expect(readFileSync(SETUP, "utf-8")).toMatch(/copyTemplateDir\(\s*path\.join\(TEMPLATE_DIR, "scripts"\)/);
  });

  it("ships the workflow-trigger script convention in the template", () => {
    expect(existsSync(WORKFLOW_TRIGGER_README)).toBe(true);
  });

  it("keeps the documented eventName pattern aligned with the Workflow schema", () => {
    const readme = readFileSync(WORKFLOW_TRIGGER_README, "utf-8");
    const documented = readme.match(/`eventName` must match `([^`]+)`/);
    expect(documented, "README must state the eventName regex").not.toBeNull();
    const pattern = new RegExp(documented![1]);
    const characters = Array.from({ length: 256 }, (_, code) => String.fromCharCode(code));
    const candidates = [
      "",
      ...characters,
      ...characters.map((character) => `A${character}`),
      "a.b-c_d",
      "A".repeat(79),
      "A".repeat(80),
      "A".repeat(81),
      "事件",
    ];

    for (const eventName of candidates) {
      const schemaAccepts = workflowNodeSchema.safeParse({
        id: "event",
        type: "trigger",
        name: "External event",
        config: { kind: "event", eventName },
      }).success;
      expect(pattern.test(eventName), JSON.stringify(eventName)).toBe(schemaAccepts);
    }
  });

  it("documents the mcp block in the default config so new users can enable it", () => {
    expect(readFileSync(SETUP, "utf-8")).toMatch(/#\s*mcp:/);
  });

  it("captures a company name independently and seeds a valid Todo-prefix source", () => {
    const source = readFileSync(SETUP, "utf-8");
    expect(source).toMatch(/What is your company called\?/);
    expect(source).toMatch(/companyName:/);
    expect(source).toMatch(/deriveTodoIdPrefix/);
  });

  it("guides engine authentication after the version probe", () => {
    expect(readFileSync(SETUP, "utf-8")).toMatch(/does NOT mean the engine is logged in/);
  });
});
