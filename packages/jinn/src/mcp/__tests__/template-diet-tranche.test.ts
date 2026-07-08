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

/** Same ~4-chars-per-token approximation the 017b measurement used. */
const approxTokens = (text: string): number => Math.ceil(text.length / 4);

describe("the GRS-017e template diet tranche (MCP-first realized)", () => {
  const template = fs.readFileSync(templatePath, "utf-8");

  it("the Child Session Protocol is now tool-shaped, not raw HTTP-shaped", () => {
    expect(template).not.toContain("grs-017e-diet:start child-session-protocol");
    expect(template).not.toContain("grs-017e-diet:end child-session-protocol");
    expect(template).toContain("### Child Session Protocol");
    expect(template).toContain("jinn_spawn_session");
    expect(template).toContain("jinn_delegate_task");
    expect(template).toContain("jinn_read_session");
    expect(template).toContain("jinn_send_to_session");
    expect(template).not.toContain("POST /api/sessions");
    expect(template).not.toContain("GET /api/sessions/{id}");
    expect(template).not.toContain("POST /api/sessions/{id}/message");
  });

  it("the endpoint-table tranche has been replaced by the MCP-first company operations surface", () => {
    expect(template).not.toContain("grs-017e-diet: at jinn-MCP default-attach");
    expect(deletableTableRows(template)).toEqual([]);
    expect(template).toContain("## Company Operations Surface");
    expect(template).toContain("Use the attached Jinn MCP tools for company operations");
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
    const toolProtocolTokens = approxTokens(section(template, "### Child Session Protocol", "### Persistent Delegation"));

    const ledger = {
      method: "approxTokens = ceil(chars/4), same as GRS-017b",
      toolShapedChildSessionProtocol: toolProtocolTokens,
      rawCompanySideDoorStringsRemaining: remainingSideDoors,
      honestReading:
        "the static child-session protocol remains present, but it is now the compact MCP tool protocol, not a raw HTTP fallback block.",
    };
    // eslint-disable-next-line no-console
    console.log(`GRS-017e-DIET-TRANCHE ${JSON.stringify(ledger, null, 2)}`);

    expect(remainingSideDoors).toEqual([]);
    expect(toolProtocolTokens).toBeGreaterThan(20);
  });
});

function section(template: string, startHeading: string, nextHeading: string): string {
  const start = template.indexOf(startHeading);
  const end = template.indexOf(nextHeading);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return template.slice(start, end);
}

/** The rows the table comment names deletable: session + org endpoints. */
function deletableTableRows(template: string): string[] {
  return template
    .split("\n")
    .filter(
      (l) =>
        (l.startsWith("| `/api/sessions") || l.startsWith("| `/api/org")) &&
        !l.includes("attachments"), // attachments has no tool equivalent and stays
    );
}
