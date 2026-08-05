import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** GRS-017e follow-through: the template now teaches the MCP/company tools as
 * the operating surface directly, so the old flip-day marker span is gone. */

const templatePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "template", "CLAUDE.md",
);
const templateRoot = path.dirname(templatePath);

/** Same ~4-chars-per-token approximation the 017b measurement used. */
const approxTokens = (text: string): number => Math.ceil(text.length / 4);

describe("the GRS-017e template diet tranche (MCP-first realized)", () => {
  const template = fs.readFileSync(templatePath, "utf-8");
  const delegationSkill = fs.readFileSync(path.join(templateRoot, "skills", "delegation", "SKILL.md"), "utf-8");

  it("the Child Session Protocol is now tool-shaped, not raw HTTP-shaped", () => {
    expect(template).not.toContain("grs-017e-diet:start child-session-protocol");
    expect(template).not.toContain("grs-017e-diet:end child-session-protocol");
    expect(template).toContain("| Delegation | `skills/delegation/SKILL.md` |");
    expect(delegationSkill).toContain("## The child-session protocol");
    expect(delegationSkill).toContain("spawn_session");
    expect(delegationSkill).toContain("delegate_task");
    expect(delegationSkill).toContain("read_session");
    expect(delegationSkill).toContain("send_to_session");
    expect(template).not.toContain("POST /api/sessions");
    expect(template).not.toContain("GET /api/sessions/{id}");
    expect(template).not.toContain("POST /api/sessions/{id}/message");
  });

  it("the endpoint-table tranche has been replaced by the MCP-first company operations surface", () => {
    expect(template).not.toContain("grs-017e-diet: at jinn-MCP default-attach");
    expect(deletableTableRows(template)).toEqual([]);
    expect(template).toContain("Use the attached Jinn MCP tools for company operations");
    expect(template).toContain("Gateway HTTP is for the web UI and platform maintenance, not routine company work.");
  });

  it("keeps the realized static-template recovery measurable", () => {
    const rawHttpStrings = [
      "POST /api/sessions",
      "GET /api/sessions/{id}",
      "POST /api/sessions/{id}/message",
      "Employees are YAML persona files",
      "You can edit any file in `~/.jinn/`",
    ];
    const remainingSideDoors = rawHttpStrings.filter((s) => template.includes(s));
    const toolProtocolTokens = approxTokens(
      section(delegationSkill, "## The child-session protocol", "## Brief quality and review"),
    );

    const ledger = {
      method: "approxTokens = ceil(chars/4), same as GRS-017b",
      toolShapedChildSessionProtocol: toolProtocolTokens,
      rawCompanySideDoorStringsRemaining: remainingSideDoors,
      honestReading:
        "the child-session protocol lives in its owning skill as a compact MCP tool protocol, not a raw HTTP fallback block.",
    };
    // eslint-disable-next-line no-console
    console.log(`GRS-017e-DIET-TRANCHE ${JSON.stringify(ledger, null, 2)}`);

    expect(remainingSideDoors).toEqual([]);
    expect(toolProtocolTokens).toBeGreaterThan(20);
  });

  it("ships compact Workflow run controls without routing through Todo tools", () => {
    const workflowSkill = fs.readFileSync(path.join(templateRoot, "skills", "workflow", "SKILL.md"), "utf-8");
    const todoSkill = fs.readFileSync(path.join(templateRoot, "skills", "todo-handling", "SKILL.md"), "utf-8");

    expect(workflowSkill).toContain("activity receipts");
    expect(workflowSkill).toContain("cancel_workflow_run");
    expect(workflowSkill).toContain("native pending approval");
    expect(workflowSkill).toContain("decide_workflow_approval");
    expect(workflowSkill).toContain("manual`, `schedule`, `event`, `todo-status`, and `workflow-call");
    expect(todoSkill).toContain("A Workflow invocation never creates, links, transitions, approves, or mutates a Todo.");
    expect(todoSkill).toContain("Todo approvals affect only the Todo.");
    expect(todoSkill).toContain("Workflow operations never mutate Todos.");
    for (const workflowControl of [
      "Workflow gate",
      "cancel_workflow_run",
      "todoTransition",
      "run's Todo",
    ]) {
      expect(todoSkill, workflowControl).not.toContain(workflowControl);
    }
  });
});

function section(template: string, startHeading: string, nextHeading: string): string {
  const start = template.indexOf(startHeading);
  const end = template.indexOf(nextHeading);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return template.slice(start, end);
}

/** The rows the MCP-first company surface replaces: session + org endpoints. */
function deletableTableRows(template: string): string[] {
  return template
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("| `/api/sessions") || l.startsWith("| `/api/org"),
    );
}
