import { gatewayRequest, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "./identity.js";

/**
 * GRS-017d — `delegate_task`, the delegation transaction (the design's §4
 * "company verb"). One tool call = tracked delegation: the gateway's
 * POST /api/delegations mints a durable WORK ITEM (the record of intent),
 * spawns the target session with the caller's brief, and links the two —
 * atomically, in-process, mint-before-spawn (the GRS-003b-2b contract). The
 * tool is a thin wrapper over that ONE route; composing mint→spawn→link as
 * three HTTP calls here would reopen exactly the partial-failure windows the
 * cron bridge spent a wave closing.
 *
 * Division of labor (stated here and in spawn_session, nowhere else):
 * delegate = company work, TRACKED (mints the accountability record);
 * spawn = quick question to a colleague, untracked.
 *
 * Policy tier: live-write, agent-allowed (design §5.2) — spawning children is
 * already sanctioned unattended production behavior (COO delegations, cron),
 * and the added work-item mint is an additive insert into a table cron writes
 * unattended on live today. No status mutation, no deletion. The tool carries
 * the fail-closed identity rule of the other scoped session tools: a caller
 * with the tool marker but NO identity is refused locally AND at the route
 * (403) — delegation always acts on behalf of a session.
 *
 * `jinn_request_review` is deliberately ABSENT: until review has distinct
 * semantics (diff refs, verdict records) it would be a second name for this
 * same transaction — delegate with a reviewer-shaped brief instead.
 */

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

function asText(body: unknown, max = 2000): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The route's response shape (201) / failure shape (>=400, may carry the
 *  preserved work item id on a post-mint spawn failure). */
interface DelegationResponse {
  workItemId?: string;
  sessionId?: string;
  employee?: string | null;
  engine?: string;
  model?: string | null;
  status?: string;
  title?: string;
  error?: string;
}

/** Non-2xx route response → a decision-shaped tool error. A post-mint spawn
 *  failure carries the preserved workItemId — surfaced so the agent knows the
 *  intent is durable, not lost. */
function delegationFailure(status: number, body: unknown): JinnMcpToolError {
  const rec = (body && typeof body === "object" ? body : {}) as DelegationResponse;
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 400) {
    return new JinnMcpToolError(`delegation rejected (400): ${detail}`);
  }
  if (status === 403) {
    return new JinnMcpToolError(`delegation refused (403): ${detail}`);
  }
  if (rec.workItemId) {
    return new JinnMcpToolError(
      `delegation spawn failed (HTTP ${status}): ${detail}. Work item ${rec.workItemId} was minted BEFORE the spawn and is preserved as backlog — the intent is durable, not lost. Report this to your parent/operator rather than re-delegating blindly (a retry mints a NEW work item).`,
    );
  }
  return new JinnMcpToolError(`delegation failed (HTTP ${status}): ${detail}`);
}

export function buildDelegationTools(): JinnMcpTool[] {
  const delegateTask: JinnMcpTool = {
    name: "delegate_task",
    description:
      "Delegate TRACKED company work: mint Todo, spawn child, link both. After delegating, END YOUR TURN; never poll in a loop.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        employee: { type: "string" },
        engine: { type: "string" },
        model: { type: "string" },
        effortLevel: { type: "string" },
        title: { type: "string" },
      },
      required: ["task"],
    },
    handler: async (args, ctx) => {
      // Fail closed on lost identity: a delegation always acts on behalf of a
      // session (the parent linkage + the accountability trail depend on it).
      if (!ctx.callerSessionId) throw new JinnMcpToolError(UNIDENTIFIED_TOOL_CALL_ERROR);
      const task = requireString(args, "task");
      const body: Record<string, unknown> = { task };
      for (const key of ["employee", "engine", "model", "effortLevel", "title"] as const) {
        const v = optionalString(args, key);
        if (v !== undefined) body[key] = v;
      }
      if (!body.employee && !body.engine) {
        throw new JinnMcpToolError(
          "provide employee or engine — delegate to a named employee (list_employees / find_employees show the roster) or to a bare engine.",
        );
      }
      const { status, body: resp } = await gatewayRequest(ctx, "POST", "/api/delegations", body);
      if (status >= 400) throw delegationFailure(status, resp);
      const d = (resp ?? {}) as DelegationResponse;
      return {
        workItemId: d.workItemId,
        sessionId: d.sessionId,
        employee: d.employee ?? null,
        engine: d.engine,
        model: d.model ?? null,
        status: d.status,
        hint:
          `Work item ${String(d.workItemId ?? "?")} tracks this; session ${String(d.sessionId ?? "?")} is executing. ` +
          "END YOUR TURN; reply wakes you. Next: read_session; never poll.",
      };
    },
  };

  return [delegateTask];
}
