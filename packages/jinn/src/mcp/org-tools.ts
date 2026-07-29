import { assertBoundCaller, gatewayGet, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";

/**
 * GRS-017b — the ORG/EMPLOYEES tool group of the `jinn` MCP server: agents
 * discover colleagues through typed tools instead of a pasted roster. This is
 * the group that pays for itself through the CONTEXT DIET: when the jinn belt
 * is attached, the context builder (sessions/context.ts) replaces the org
 * roster and the delegation-curl recipes with a short manifest pointing here —
 * the measured net saving is the slice's acceptance
 * (mcp/__tests__/context-diet.test.ts).
 *
 * Contract (012d-0 admission rules): deterministic wrappers over the org read
 * routes. `find_employees` is a deterministic AND-filter on DECLARED
 * fields (department / rank / engine) — it never ranks "fit"; judging which
 * matching employee suits a task is the calling engine's job over the returned
 * list (no LLM inside tools).
 */

interface OrgEmployeeRecord {
  name?: string;
  displayName?: string;
  department?: string;
  role?: string;
  rank?: string;
  engine?: string;
  model?: string;
  parentName?: string | null;
  directReports?: string[];
}

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  return s;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new JinnMcpToolError(`${name} must be a non-empty string when provided`);
  return v.trim();
}

/** Compact roster row — never the persona (that's get_employee's job). */
function summarize(e: OrgEmployeeRecord): Record<string, unknown> {
  return {
    name: e.name,
    displayName: e.displayName,
    department: e.department,
    role: e.role,
    rank: e.rank,
    engine: e.engine,
    reportsTo: e.parentName ?? null,
    directReports: e.directReports ?? [],
  };
}

async function fetchOrgEmployees(ctx: JinnMcpContext): Promise<OrgEmployeeRecord[]> {
  assertBoundCaller(ctx);
  const { status, body } = await gatewayGet(ctx, "/api/org");
  if (status >= 400) throw new JinnMcpToolError(`gateway GET /api/org returned HTTP ${status}`);
  const rec = (body ?? {}) as { employees?: OrgEmployeeRecord[] };
  return Array.isArray(rec.employees) ? rec.employees : [];
}

export function buildOrgTools(): JinnMcpTool[] {
  const listEmployees: JinnMcpTool = {
    name: "list_employees",
    description: "List compact employee rows: name, role, rank, department, engine, reporting.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      assertBoundCaller(ctx);
      const { status, body } = await gatewayGet(ctx, "/api/org");
      if (status >= 400) {
        throw new JinnMcpToolError(`gateway GET /api/org returned HTTP ${status}`);
      }
      return body;
    },
  };

  const getEmployee: JinnMcpTool = {
    name: "get_employee",
    description: "Get one employee full record by slug.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const name = requireString(args, "name");
      const { status, body } = await gatewayGet(ctx, `/api/org/employees/${encodeURIComponent(name)}`);
      if (status === 404) {
        throw new JinnMcpToolError(
          `employee "${name}" not found. Discover valid slugs with find_employees (filter by department/rank/engine) or list_employees.`,
        );
      }
      if (status >= 400) throw new JinnMcpToolError(`getting employee "${name}" failed (HTTP ${status})`);
      return {
        employee: body,
        hint: `Next: spawn_session { employee: "${name}", prompt: ... } or delegate_task.`,
      };
    },
  };

  const findEmployees: JinnMcpTool = {
    name: "find_employees",
    description: "Returns compact rows with role, not full personas; call get_employee for finalists.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string" },
        rank: { type: "string" },
        engine: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const filters: Array<{ field: "department" | "rank" | "engine"; value: string }> = [];
      for (const field of ["department", "rank", "engine"] as const) {
        const v = optionalString(args, field);
        if (v !== undefined) filters.push({ field, value: v.toLowerCase() });
      }
      if (filters.length === 0) {
        throw new JinnMcpToolError(
          "pass at least one filter (department, rank, engine) — for the whole roster use list_employees.",
        );
      }
      const employees = await fetchOrgEmployees(ctx);
      const matches = employees.filter((e) =>
        filters.every(({ field, value }) => String(e[field] ?? "").toLowerCase() === value),
      );
      if (matches.length === 0) {
        // Deterministic self-correction data: the observed value sets for the
        // filtered fields, so the agent fixes a typo without another probe.
        const observed = filters
          .map(({ field }) => {
            const values = [...new Set(employees.map((e) => String(e[field] ?? "")).filter(Boolean))].sort();
            return `${field} ∈ {${values.join(", ")}}`;
          })
          .join("; ");
        return {
          matches: [],
          hint: `No match. Observed ${observed}. Next: list_employees.`,
        };
      }
      return {
        matches: matches.map(summarize),
        hint: "Next: get_employee { name } or spawn_session.",
      };
    },
  };

  return [listEmployees, getEmployee, findEmployees];
}
