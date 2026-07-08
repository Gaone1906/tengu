import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * GRS-017b — THE CONTEXT DIET, MEASURED. This is the slice's acceptance and the
 * payoff that justifies the MCP-default direction (vision §MCP-default; catalog
 * §6: a read tool that shrinks no prompt does not ship).
 *
 * Method: build the REAL bootstrap prompt (buildContext) twice over a synthetic
 * 40-employee org — once without the jinn belt (today's prose) and once with
 * `jinnMcpAttached: true` (roster/escalation/delegation-curl prose replaced by
 * tool manifests) — and compare token counts against the tool-schema tokens the
 * belt adds. Tokens are approximated as ceil(chars / 4) (the standard heuristic;
 * no tokenizer dependency), applied identically to both sides.
 *
 * Ledgers asserted:
 *   1. SLICE GATE (must pass to ship): the bootstrap saving exceeds the schema
 *      cost of the two tools this slice adds (jinn_get_employee,
 *      jinn_find_employees) — the catalog's per-tool rule.
 *   2. COMMS-SURFACE ledger (org + sessions groups vs the prose they replace):
 *      reported in the measurement output; the workflow group is excluded — it
 *      was admitted under the catalog's "enables a concrete action" arm
 *      (GRS-015), not prompt replacement, so it owes no prose.
 * The full measurement JSON is printed for the committed snapshot in
 * reports/implementation/GRS-017b-diet-measurement.json.
 */

// Isolated home BEFORE imports so no personal ~/.jinn content leaks into the
// measured prompts (privacy firewall). Cron is seeded below to prove the
// MCP-attached bootstrap uses the read-tool manifest instead of inline jobs.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-diet-home-"));
fs.mkdirSync(path.join(process.env.JINN_HOME, "cron"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.JINN_HOME, "cron", "jobs.json"),
  JSON.stringify(
    Array.from({ length: 80 }, (_, i) => ({
      id: `job-${String(i).padStart(2, "0")}`,
      name: `Job ${String(i).padStart(2, "0")}`,
      schedule: `${i % 60} ${i % 24} * * *`,
      prompt: "Long cron prompt body omitted from the MCP-attached bootstrap.",
      enabled: i % 5 !== 0,
      employee: `alpha-worker-${(i % 4) + 1}`,
    })),
    null,
    2,
  ),
);

type ContextMod = typeof import("../../sessions/context.js");
type OrgHierarchyMod = typeof import("../../gateway/org-hierarchy.js");
type ServerMod = typeof import("../server.js");
type Employee = import("../../shared/types.js").Employee;

let buildContext: ContextMod["buildContext"];
let resolveOrgHierarchy: OrgHierarchyMod["resolveOrgHierarchy"];
let buildTools: ServerMod["buildTools"];

beforeAll(async () => {
  ({ buildContext } = await import("../../sessions/context.js"));
  ({ resolveOrgHierarchy } = await import("../../gateway/org-hierarchy.js"));
  ({ buildTools } = await import("../server.js"));
});

/** The standard ~4-chars-per-token approximation, applied to BOTH sides. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Synthetic org at the operator's real scale: 8 departments × (1 manager + 4 seniors). */
function syntheticOrg(): Map<string, Employee> {
  const registry = new Map<string, Employee>();
  const departments = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  for (const dept of departments) {
    const lead = `${dept}-lead`;
    registry.set(lead, {
      name: lead,
      displayName: `${dept[0].toUpperCase()}${dept.slice(1)} Lead`,
      department: dept,
      rank: "manager",
      engine: "codex",
      model: "gpt-5.5",
      persona: `Leads the ${dept} department.`,
    } as Employee);
    for (let i = 1; i <= 4; i++) {
      const name = `${dept}-worker-${i}`;
      registry.set(name, {
        name,
        displayName: `${dept[0].toUpperCase()}${dept.slice(1)} Worker ${i}`,
        department: dept,
        rank: "senior",
        engine: i % 2 === 0 ? "claude" : "codex",
        model: "default",
        persona: `Works in the ${dept} department.`,
        reportsTo: lead,
      } as Employee);
    }
  }
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config: any = {
  gateway: { port: 7777 },
  engines: { default: "codex" },
  // No trimming — the measurement compares full prompts.
  context: { maxChars: 1_000_000 },
};

function buildBootstrap(opts: { employee?: Employee; jinnMcpAttached: boolean }): string {
  const registry = syntheticOrg();
  const hierarchy = resolveOrgHierarchy(registry);
  return buildContext({
    source: "web",
    channel: "web:test",
    user: "operator",
    sessionId: "diet-test-session",
    config,
    hierarchy,
    employee: opts.employee,
    jinnMcpAttached: opts.jinnMcpAttached,
  });
}

/** Serialize tool schemas exactly as tools/list sends them — that is the cost. */
function schemaTokens(names?: string[]): number {
  const tools = buildTools()
    .filter((t) => !names || names.includes(t.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  return approxTokens(JSON.stringify(tools));
}

const ORG_GROUP = ["jinn_list_employees", "jinn_get_employee", "jinn_find_employees"];
const NEW_IN_THIS_SLICE = ["jinn_get_employee", "jinn_find_employees"];
const SESSION_GROUP = ["jinn_spawn_session", "jinn_send_to_session", "jinn_read_session", "jinn_list_sessions", "jinn_stop_session"];
const COST_CRON_GROUP = ["jinn_cost_report", "jinn_list_cron_jobs", "jinn_get_cron_run_history"];
const WORK_ITEM_GROUP = [
  "jinn_list_work_items",
  "jinn_get_work_item",
  "jinn_search_work_items",
  "jinn_create_work_item",
  "jinn_update_work_item",
  "jinn_assign_work_item",
];

describe("the measured context diet", () => {
  it("flag off (or absent) leaves the bootstrap byte-identical — no behavior change for non-MCP sessions", () => {
    const off = buildBootstrap({ jinnMcpAttached: false });
    const registry = syntheticOrg();
    const hierarchy = resolveOrgHierarchy(registry);
    const absent = buildContext({
      source: "web",
      channel: "web:test",
      user: "operator",
      sessionId: "diet-test-session",
      config,
      hierarchy,
    });
    expect(off).toBe(absent);
  });

  it("with the belt attached, the roster prose is genuinely GONE (not appended-to) and the manifest points at the tools", () => {
    const before = buildBootstrap({ jinnMcpAttached: false });
    const after = buildBootstrap({ jinnMcpAttached: true });
    // A mid-roster employee appears in the pasted roster, not in the manifest.
    expect(before).toContain("delta-worker-3");
    expect(after).not.toContain("delta-worker-3");
    expect(after).toContain("jinn_find_employees");
    expect(after).toContain("(40 employee(s))"); // scale stays, roster goes
  });

  it("with the belt attached, cron prose is replaced by the cron read-tool manifest", () => {
    const before = buildBootstrap({ jinnMcpAttached: false });
    const after = buildBootstrap({ jinnMcpAttached: true });
    expect(before).toContain("Job 17");
    expect(before).toContain("alpha-worker-2");
    expect(after).not.toContain("Job 17");
    expect(after).not.toContain("alpha-worker-2");
    expect(after).toContain("jinn_list_cron_jobs");
    expect(after).toContain("jinn_get_cron_run_history");
  });

  it("SLICE GATE: the COO-bootstrap saving exceeds the schema cost of the tools this slice adds", () => {
    const before = approxTokens(buildBootstrap({ jinnMcpAttached: false }));
    const after = approxTokens(buildBootstrap({ jinnMcpAttached: true }));
    const saving = before - after;
    const newToolsCost = schemaTokens(NEW_IN_THIS_SLICE);
    expect(saving).toBeGreaterThan(0);
    expect(saving - newToolsCost).toBeGreaterThan(0); // net negative context cost
  });

  it("a manager-employee bootstrap also shrinks (delegation curls + escalation prose → manifests)", () => {
    const manager = syntheticOrg().get("alpha-lead")!;
    const before = approxTokens(buildBootstrap({ employee: manager, jinnMcpAttached: false }));
    const after = approxTokens(buildBootstrap({ employee: manager, jinnMcpAttached: true }));
    expect(after).toBeLessThan(before);
  });

  it("prints the full measurement ledger (the committed snapshot's source)", () => {
    const cooBefore = approxTokens(buildBootstrap({ jinnMcpAttached: false }));
    const cooAfter = approxTokens(buildBootstrap({ jinnMcpAttached: true }));
    const manager = syntheticOrg().get("alpha-lead")!;
    const mgrBefore = approxTokens(buildBootstrap({ employee: manager, jinnMcpAttached: false }));
    const mgrAfter = approxTokens(buildBootstrap({ employee: manager, jinnMcpAttached: true }));

    const measurement = {
      method: "approxTokens = ceil(chars/4), identical on both sides; synthetic 40-employee org (8 depts × 1 manager + 4 seniors)",
      cooBootstrap: { before: cooBefore, after: cooAfter, saving: cooBefore - cooAfter },
      managerBootstrap: { before: mgrBefore, after: mgrAfter, saving: mgrBefore - mgrAfter },
      schemaCosts: {
        newInThisSlice: schemaTokens(NEW_IN_THIS_SLICE),
        orgGroup: schemaTokens(ORG_GROUP),
        sessionGroup: schemaTokens(SESSION_GROUP),
        costCronGroup: schemaTokens(COST_CRON_GROUP),
        workItemGroup: schemaTokens(WORK_ITEM_GROUP),
        commsSurface: schemaTokens([...ORG_GROUP, ...SESSION_GROUP]),
        fullBelt: schemaTokens(),
      },
      ledgers: {
        sliceGate_cooSavingMinusNewTools: cooBefore - cooAfter - schemaTokens(NEW_IN_THIS_SLICE),
        costCronCheckpoint_cooSavingMinusCostCronSchemas: cooBefore - cooAfter - schemaTokens(COST_CRON_GROUP),
        commsSurface_cooSavingMinusOrgAndSessionGroups: cooBefore - cooAfter - schemaTokens([...ORG_GROUP, ...SESSION_GROUP]),
      },
    };
    // eslint-disable-next-line no-console
    console.log(`GRS-017b-DIET-MEASUREMENT ${JSON.stringify(measurement, null, 2)}`);
    expect(measurement.ledgers.sliceGate_cooSavingMinusNewTools).toBeGreaterThan(0);
    expect(measurement.ledgers.costCronCheckpoint_cooSavingMinusCostCronSchemas).toBeGreaterThan(0);
  });
});
