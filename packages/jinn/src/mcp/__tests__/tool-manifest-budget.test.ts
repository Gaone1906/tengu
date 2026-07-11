import { describe, expect, it } from "vitest";
import { buildTools } from "../server.js";

const EXPECTED_TOOL_NAMES = [
  "archive_work_item",
  "assign_work_item",
  "cost_report",
  "create_trigger",
  "create_work_item",
  "create_workflow",
  "decide_work_item_approval",
  "delegate_task",
  "delete_trigger",
  "edit_workflow_run_step_prompt",
  "escalate_work_item_approval",
  "find_employees",
  "get_cron_run_history",
  "get_employee",
  "get_message_context",
  "get_work_item",
  "get_workflow",
  "get_workflow_run",
  "list_cron_jobs",
  "list_employees",
  "list_files",
  "list_sessions",
  "list_triggers",
  "list_work_items",
  "list_workflow_runs",
  "list_workflows",
  "plan_workflow",
  "read_file",
  "read_knowledge",
  "read_session",
  "request_work_item_approval",
  "retire_workflow",
  "run_workflow_by_name",
  "search_knowledge",
  "search_messages",
  "search_sessions",
  "search_work_items",
  "send_to_session",
  "spawn_session",
  "start_workflow_run",
  "stop_session",
  "update_work_item",
  "update_workflow",
  "validate_workflow",
] as const;

const EXPECTED_REQUIRED = {
  archive_work_item: ["id"],
  assign_work_item: ["id", "assignee"],
  cost_report: [],
  create_trigger: ["kind", "name", "event", "targetWorkflowId"],
  create_work_item: ["title"],
  create_workflow: [],
  decide_work_item_approval: ["id", "decision"],
  delegate_task: ["task"],
  delete_trigger: ["name"],
  edit_workflow_run_step_prompt: ["workflowId", "runId", "nodeId", "prompt"],
  escalate_work_item_approval: ["id"],
  find_employees: [],
  get_cron_run_history: ["id"],
  get_employee: ["name"],
  get_message_context: ["sessionId", "messageId"],
  get_work_item: ["id"],
  get_workflow: ["workflowId"],
  get_workflow_run: ["workflowId", "runId"],
  list_cron_jobs: [],
  list_employees: [],
  list_files: [],
  list_sessions: [],
  list_triggers: [],
  list_work_items: [],
  list_workflow_runs: ["workflowId"],
  list_workflows: [],
  plan_workflow: [],
  read_file: ["path"],
  read_knowledge: ["path"],
  read_session: ["sessionId"],
  request_work_item_approval: ["id", "request"],
  retire_workflow: ["workflowId"],
  run_workflow_by_name: ["name"],
  search_knowledge: ["query"],
  search_messages: ["query"],
  search_sessions: [],
  search_work_items: [],
  send_to_session: ["sessionId", "message"],
  spawn_session: ["prompt"],
  start_workflow_run: ["workflowId"],
  stop_session: ["sessionId"],
  update_work_item: ["id", "status"],
  update_workflow: ["workflowId"],
  validate_workflow: [],
} as const;

const EXPECTED_ENUMS = {
  cost_report: [["properties.groupBy", ["employee", "day"]]],
  create_trigger: [["properties.kind", ["webhook", "poll"]]],
  decide_work_item_approval: [["properties.decision", ["approve", "reject"]]],
  list_sessions: [["properties.scope", ["children", "employee", "recent"]]],
  list_work_items: [
    ["properties.status", ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"]],
    ["properties.source", ["human", "delegation", "cron", "workflow", "session", "connector", "goal"]],
  ],
  search_messages: [["properties.role", ["user", "assistant"]]],
  search_sessions: [["properties.status", ["idle", "running", "error", "waiting", "interrupted"]]],
  search_work_items: [
    ["properties.status", ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"]],
    ["properties.source", ["human", "delegation", "cron", "workflow", "session", "connector", "goal"]],
  ],
  update_work_item: [["properties.status", ["executing", "in_review", "blocked", "escalated", "done"]]],
} as const;

function collectEnums(value: unknown, path: string[] = []): Array<[string, string[]]> {
  if (!value || typeof value !== "object") return [];
  const schema = value as Record<string, unknown>;
  const own = Array.isArray(schema.enum) ? ([[path.join("."), schema.enum as string[]]] as Array<[string, string[]]>) : [];
  return [
    ...own,
    ...Object.entries(schema).flatMap(([key, child]) => collectEnums(child, [...path, key])),
  ];
}

describe("tool manifest budget", () => {
  it("keeps the tools/list manifest under the upfront token budget", () => {
    const tools = buildTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    const payload = JSON.stringify({ tools });
    // Local $defs keep the closed workflow graph contract compact. This is tighter
    // than the initial inline-schema allowance while retaining every nested closure.
    expect(Math.ceil(payload.length / 4)).toBeLessThanOrEqual(4000);
  });

  it("keeps tool names, required arrays, and enum arrays stable", () => {
    const tools = buildTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(tools).toHaveLength(44);

    const required = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required ?? []]));
    expect(required).toEqual(EXPECTED_REQUIRED);

    const enums = Object.fromEntries(
      tools
        .map((t) => [t.name, collectEnums(t.inputSchema)] as const)
        .filter(([, entries]) => entries.length > 0),
    );
    expect(enums).toEqual(EXPECTED_ENUMS);
  });
});
