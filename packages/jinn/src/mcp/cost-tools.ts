import { assertBoundCaller, gatewayGet, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";

const GROUP_BY = ["employee", "day"] as const;
const FILTER_CHAR_CAP = 256;

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new JinnMcpToolError(`${name} must be a non-empty string when provided`);
  const s = v.trim();
  if (s.length > FILTER_CHAR_CAP) throw new JinnMcpToolError(`${name} is too long (${s.length} chars, max ${FILTER_CHAR_CAP}) — shorten it and try again`);
  return s;
}

function optionalIso(args: Record<string, unknown>, name: string): string | undefined {
  const v = optionalString(args, name);
  if (v === undefined) return undefined;
  if (Number.isNaN(Date.parse(v))) throw new JinnMcpToolError(`${name} must be an ISO-8601 timestamp`);
  return v;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

function asText(body: unknown, max = 800): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

export function buildCostTools(): JinnMcpTool[] {
  return [
    {
      name: "cost_report",
      description:
        "Report deterministic spend from existing session accounting. Groups sessions.total_cost/total_turns by employee or day with optional time range and employee filter. Cost-only read surface: no budgets, thresholds, work-item joins, or mutations.",
      inputSchema: {
        type: "object",
        properties: {
          groupBy: { type: "string", enum: [...GROUP_BY], description: 'Group rows by "employee" or "day" (default employee).' },
          since: { type: "string" },
          until: { type: "string" },
          employee: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (args, ctx) => {
        assertBoundCaller(ctx);
        const groupBy = optionalString(args, "groupBy") ?? "employee";
        if (!(GROUP_BY as readonly string[]).includes(groupBy)) {
          throw new JinnMcpToolError(`groupBy must be one of ${GROUP_BY.join(", ")}, got "${groupBy}"`);
        }
        const query = qs({
          groupBy,
          since: optionalIso(args, "since"),
          until: optionalIso(args, "until"),
          employee: optionalString(args, "employee"),
          limit: clampInt(args.limit, 100, 1, 100),
        });
        const { status, body } = await gatewayGet(ctx, `/api/cost/report?${query}`);
        if (status >= 400) throw gatewayFailure("reading cost report", status, body);
        return {
          ...(body as Record<string, unknown>),
          hint: "Costs are engine-reported per session; missing/zero rows mean the engine reported none.",
        };
      },
    },
  ];
}
