import { assertBoundCaller, gatewayGet, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import { summarizeCronRun } from "../cron/run-summary.js";

const FILTER_CHAR_CAP = 256;
const CRON_RUN_LIMIT_DEFAULT = 10;
const CRON_RUN_LIMIT_MAX = 10;

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  if (s.length > FILTER_CHAR_CAP) throw new JinnMcpToolError(`${name} is too long (${s.length} chars, max ${FILTER_CHAR_CAP}) — shorten it and try again`);
  return s;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function asText(body: unknown, max = 800): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  if (status === 404) return new JinnMcpToolError(`${what} failed (404): ${detail || "not found"}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

function shapeCronJob(job: Record<string, unknown>): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: job.enabled !== false,
    employee: job.employee ?? null,
    engine: job.engine ?? null,
    timezone: job.timezone ?? null,
    lastRun: job.lastRun && typeof job.lastRun === "object" && !Array.isArray(job.lastRun)
      ? shapeRun(job.lastRun as Record<string, unknown>)
      : null,
  };
}

function shapeRun(run: Record<string, unknown>): Record<string, unknown> {
  return summarizeCronRun(run);
}

export function buildCronTools(): JinnMcpTool[] {
  const list: JinnMcpTool = {
    name: "list_cron_jobs",
    description: "List cron jobs.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      assertBoundCaller(ctx);
      const { status, body } = await gatewayGet(ctx, "/api/cron");
      if (status >= 400) throw gatewayFailure("listing cron jobs", status, body);
      const cronJobs = Array.isArray(body) ? body.map((j) => shapeCronJob(j as Record<string, unknown>)) : [];
      return {
        cronJobs,
        hint: cronJobs.length ? "Next: get_cron_run_history { id }." : "No cron jobs configured.",
      };
    },
  };

  const history: JinnMcpTool = {
    name: "get_cron_run_history",
    description: "Read safe cron run history.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        limit: { type: "number" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "id");
      const limit = clampInt(args.limit, CRON_RUN_LIMIT_DEFAULT, 1, CRON_RUN_LIMIT_MAX);
      const { status, body } = await gatewayGet(ctx, `/api/cron/${encodeURIComponent(id)}/runs?limit=${limit}`);
      if (status >= 400) throw gatewayFailure(`reading cron run history for "${id}"`, status, body);
      const runs = Array.isArray(body) ? body.map((r) => shapeRun(r as Record<string, unknown>)) : [];
      return {
        id,
        runs,
        hint: runs.length ? "Next: read_session or get_work_item from linked ids." : "No recorded runs.",
      };
    },
  };

  return [list, history];
}
