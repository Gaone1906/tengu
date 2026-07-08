import { describe, expect, it } from "vitest";
import { buildTools } from "../server.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

const READ_TOOL_CASES: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "jinn_list_work_items", args: {} },
  { name: "jinn_get_work_item", args: { id: "wi_test" } },
  { name: "jinn_search_work_items", args: { status: "backlog" } },
  { name: "jinn_list_sessions", args: { scope: "recent" } },
  { name: "jinn_read_session", args: { sessionId: "sess_test" } },
  { name: "jinn_search_messages", args: { query: "needle" } },
  { name: "jinn_search_sessions", args: { employee: "worker" } },
  { name: "jinn_get_message_context", args: { sessionId: "sess_test", messageId: "msg_test" } },
  { name: "jinn_search_knowledge", args: { query: "needle" } },
  { name: "jinn_read_knowledge", args: { path: "knowledge/demo.md" } },
  { name: "jinn_cost_report", args: {} },
  { name: "jinn_list_cron_jobs", args: {} },
  { name: "jinn_get_cron_run_history", args: { id: "daily" } },
  { name: "jinn_list_employees", args: {} },
  { name: "jinn_get_employee", args: { name: "worker" } },
  { name: "jinn_find_employees", args: { rank: "senior" } },
  { name: "jinn_list_workflows", args: {} },
  { name: "jinn_get_workflow", args: { workflowId: "wf_test" } },
  { name: "jinn_list_workflow_runs", args: { workflowId: "wf_test" } },
  { name: "jinn_get_workflow_run", args: { workflowId: "wf_test", runId: "run_test" } },
  {
    name: "jinn_plan_workflow",
    args: { sop: { id: "wf_test", title: "Test", wakeUp: { kind: "manual" }, steps: [{ engine: "codex", instruction: "Do it." }] } },
  },
  {
    name: "jinn_validate_workflow",
    args: { sop: { id: "wf_test", title: "Test", wakeUp: { kind: "manual" }, steps: [{ engine: "codex", instruction: "Do it." }] } },
  },
  { name: "jinn_list_triggers", args: {} },
  { name: "jinn_list_files", args: {} },
  { name: "jinn_read_file", args: { path: "files/demo.txt" } },
];

function tool(name: string): JinnMcpTool {
  const t = buildTools().find((candidate) => candidate.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

function noNetworkCtx(extra: Partial<JinnMcpContext> = {}): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: (async () => {
      throw new Error("read tool should reject before reaching the gateway without a bound capability");
    }) as unknown as typeof fetch,
    ...extra,
  };
}

describe("MCP read tools — local capability binding", () => {
  it.each(READ_TOOL_CASES)("$name rejects before any route call when caller identity is missing", async ({ name, args }) => {
    await expect(tool(name).handler(args, noNetworkCtx())).rejects.toThrow(/caller identity unavailable/i);
  });

  it.each(READ_TOOL_CASES)("$name rejects before any route call when caller capability is missing", async ({ name, args }) => {
    await expect(tool(name).handler(args, noNetworkCtx({ callerSessionId: "sess_claim" }))).rejects.toThrow(
      /caller identity unavailable/i,
    );
  });
});
