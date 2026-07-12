import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildTools } from "../server.js";
import { projectPiToolManifest } from "../../engines/pi-mcp.js";

const MAX_MANIFEST_TOKENS = 7000;
// Exact gate: js-tiktoken 1.0.21 with its local o200k_base ranks. The provider
// projection is the OpenAI Responses API function-tool request shape pinned on 2026-07-12.
const ATTESTED = {
  rpc: { tokens: 6655, sha256: "342c09a9741d889b2b740b02918381f12a681ae8fd4fa92d68f1a992c88511c6" },
  pi: { tokens: 6953, sha256: "61871df2e2542ba46960bd88efec6c045d5989b8e4c6650e0d8c214fbe998440" },
  openai: { tokens: 6773, sha256: "2845af554dee06286b5c2548fedfee656030e59d913c0f103e53e7d37a4a726c" },
} as const;

type TokenizerLoader = () => Promise<[{ Tiktoken: typeof import("js-tiktoken/lite").Tiktoken }, { default: typeof import("js-tiktoken/ranks/o200k_base").default }]>;
const loadPinnedTokenizer: TokenizerLoader = () => Promise.all([
  import("js-tiktoken/lite"),
  import("js-tiktoken/ranks/o200k_base"),
]);

async function exactOrAttested(name: keyof typeof ATTESTED, payload: string, loadTokenizer: TokenizerLoader = loadPinnedTokenizer): Promise<number> {
  try {
    const [{ Tiktoken }, ranks] = await loadTokenizer();
    return new Tiktoken(ranks.default).encode(payload).length;
  } catch {
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    if (hash !== ATTESTED[name].sha256) throw new Error(`tokenizer unavailable and ${name} manifest is not the attested golden payload`);
    return ATTESTED[name].tokens;
  }
}

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
  it("keeps exact JSON-RPC, owned Pi, and pinned OpenAI wrapper manifests under 7000 o200k_base tokens", async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const wrappers = {
      rpc: { jsonrpc: "2.0", id: 1, result: { tools } },
      pi: { tools: projectPiToolManifest(tools) },
      // Pinned provider fixture: OpenAI Responses API function tool shape (2026-07-12).
      openai: { tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", name, description, parameters: inputSchema })) },
    } as const;
    // MCP input-schema references are document-local, so plan/validate/create/update
    // must each carry the closed authoring contract they advertise. Keep that safety
    // contract self-contained while bounding the intentional manifest increase.
    for (const [name, wrapper] of Object.entries(wrappers) as Array<[keyof typeof wrappers, unknown]>) {
      expect(await exactOrAttested(name, JSON.stringify(wrapper))).toBeLessThanOrEqual(MAX_MANIFEST_TOKENS);
    }
  });

  it("fails closed when a 310-character manifest mutation exceeds the cap", async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const prose = sentence.repeat(3).slice(0, 310);
    expect(prose).toHaveLength(310);
    const mutated = { tools: projectPiToolManifest(tools), mutation: prose };
    expect(await exactOrAttested("pi", JSON.stringify(mutated))).toBeGreaterThan(MAX_MANIFEST_TOKENS);
  });

  it("uses attestation only for the unchanged golden when the pinned tokenizer is unavailable", async () => {
    const unavailable: TokenizerLoader = async () => { throw new Error("simulated unavailable tokenizer"); };
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const golden = JSON.stringify({ tools: projectPiToolManifest(tools) });
    expect(await exactOrAttested("pi", golden, unavailable)).toBe(ATTESTED.pi.tokens);

    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const changed = JSON.stringify({ tools: projectPiToolManifest(tools), mutation: sentence.repeat(3).slice(0, 310) });
    await expect(exactOrAttested("pi", changed, unavailable)).rejects.toThrow(/not the attested golden payload/);
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
        .filter(([name]) => !["plan_workflow", "validate_workflow", "create_workflow", "update_workflow"].includes(name))
        .filter(([, entries]) => entries.length > 0),
    );
    expect(enums).toEqual(EXPECTED_ENUMS);
  });
});
