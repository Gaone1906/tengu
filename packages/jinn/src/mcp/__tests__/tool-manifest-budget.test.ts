import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildTools } from "../server.js";
import { projectPiToolManifest } from "../../engines/pi-mcp.js";

// Fixed provider budget. Rebased for Todos v2 slice 4 (edit_work_item) with the
// same ~zero headroom discipline as before: new tool prose must stay concise
// rather than growing into this ceiling.
const MAX_MANIFEST_TOKENS = 4649;
// Exact gate: js-tiktoken 1.0.21 with its local o200k_base ranks. The provider
// projection is the OpenAI Responses API function-tool request shape pinned on 2026-07-12.
const ATTESTED = {
  rpc: { tokens: 4244, sha256: "454e0f2369f41f106741ae256e72d81fce66e8c8563a7b9cc2083745424c3be8" },
  pi: { tokens: 4647, sha256: "70e1db0fba86f0f1919b263d3622372f2d93318087f6168c639e42a43c0d8831" },
  openai: { tokens: 4407, sha256: "f8bacab3e70ef32a473b5023bf31a46b2885caf4aff8667d1900678e0ed9fe72" },
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
    if (hash !== ATTESTED[name].sha256) throw new Error(`tokenizer unavailable and ${name} manifest is not the attested golden payload (${hash})`);
    return ATTESTED[name].tokens;
  }
}

const EXPECTED_TOOL_NAMES = [
  "archive_work_item",
  "assign_work_item",
  "cancel_workflow_run",
  "comment_work_item",
  "cost_report",
  "create_note",
  "create_work_item",
  "create_workflow",
  "decide_workflow_approval",
  "decide_work_item_approval",
  "delegate_task",
  "disable_workflow",
  "duplicate_workflow",
  "edit_work_item",
  "enable_workflow",
  "escalate_work_item_approval",
  "find_employees",
  "fire_workflow_event",
  "get_cron_run_history",
  "get_employee",
  "get_message_context",
  "get_work_item",
  "get_work_item_tree",
  "get_workflow",
  "get_workflow_run",
  "label_work_item",
  "link_work_items",
  "list_cron_jobs",
  "list_employees",
  "list_files",
  "list_labels",
  "list_notes",
  "list_sessions",
  "list_work_item_comments",
  "list_work_items",
  "list_workflow_runs",
  "list_workflows",
  "publish_attachment",
  "read_file",
  "read_knowledge",
  "read_note",
  "read_session",
  "request_work_item_approval",
  "retire_workflow",
  "rerun_workflow_run",
  "retry_workflow_node",
  "search_knowledge",
  "search_messages",
  "search_sessions",
  "search_work_items",
  "send_to_session",
  "send_connector_message",
  "spawn_session",
  "start_workflow_run",
  "stop_session",
  "unlink_work_items",
  "update_note",
  "update_work_item",
  "update_workflow",
] as const;

const EXPECTED_REQUIRED = {
  archive_work_item: ["id"],
  assign_work_item: ["id", "assignee"],
  cancel_workflow_run: ["workflowId", "runId"],
  comment_work_item: ["id", "body"],
  cost_report: [],
  create_note: ["title"],
  create_work_item: ["title"],
  create_workflow: ["id", "title"],
  decide_workflow_approval: ["workflowId", "runId", "nodeId", "decision", "expectedRevision"],
  decide_work_item_approval: ["id", "decision"],
  delegate_task: ["task"],
  disable_workflow: ["workflowId", "expectedRevision"],
  duplicate_workflow: ["sourceId", "id", "title"],
  edit_work_item: ["id"],
  enable_workflow: ["workflowId", "expectedRevision"],
  escalate_work_item_approval: ["id"],
  find_employees: [],
  fire_workflow_event: ["eventName", "fireId", "payload"],
  get_cron_run_history: ["id"],
  get_employee: ["name"],
  get_message_context: ["sessionId", "messageId"],
  get_work_item: ["id"],
  get_work_item_tree: ["id"],
  get_workflow: ["workflowId"],
  get_workflow_run: ["workflowId", "runId"],
  label_work_item: ["id", "labels"],
  link_work_items: ["srcId", "dstId", "kind"],
  list_cron_jobs: [],
  list_employees: [],
  list_files: [],
  list_labels: [],
  list_notes: [],
  list_sessions: [],
  list_work_item_comments: ["id"],
  list_work_items: [],
  list_workflow_runs: ["workflowId"],
  list_workflows: [],
  publish_attachment: ["path"],
  read_file: ["path"],
  read_knowledge: ["path"],
  read_note: ["path"],
  read_session: ["sessionId"],
  request_work_item_approval: ["id", "request"],
  retire_workflow: ["workflowId", "expectedRevision"],
  rerun_workflow_run: ["workflowId", "runId", "definition", "idempotencyKey"],
  retry_workflow_node: ["workflowId", "runId", "nodeId", "idempotencyKey"],
  search_knowledge: ["query"],
  search_messages: ["query"],
  search_sessions: [],
  search_work_items: [],
  send_to_session: ["sessionId", "message"],
  send_connector_message: ["connector", "channel", "text"],
  spawn_session: ["prompt"],
  start_workflow_run: ["workflowId"],
  stop_session: ["sessionId"],
  unlink_work_items: ["srcId", "dstId", "kind"],
  update_note: ["path", "expectedRevision"],
  update_work_item: ["id", "status"],
  update_workflow: ["workflowId", "definition", "expectedRevision"],
} as const;

const EXPECTED_ENUMS = {
  cost_report: [["properties.groupBy", ["employee", "day"]]],
  create_work_item: [["properties.priority", [0, 1, 2, 3]]],
  decide_workflow_approval: [["properties.decision", ["approve", "reject"]]],
  decide_work_item_approval: [["properties.decision", ["approve", "reject"]]],
  edit_work_item: [["properties.priority", [0, 1, 2, 3]]],
  link_work_items: [["properties.kind", ["blocks", "relates", "duplicates"]]],
  list_sessions: [["properties.scope", ["children", "employee", "recent"]]],
  list_work_items: [
    ["properties.status", ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"]],
    ["properties.source", ["human", "delegation", "cron", "workflow", "session", "connector", "goal"]],
  ],
  search_messages: [["properties.role", ["user", "assistant"]]],
  search_sessions: [["properties.status", ["idle", "running", "error", "waiting", "interrupted"]]],
  rerun_workflow_run: [["properties.definition", ["original", "current"]]],
  search_work_items: [
    ["properties.status", ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"]],
    ["properties.source", ["human", "delegation", "cron", "workflow", "session", "connector", "goal"]],
  ],
  unlink_work_items: [["properties.kind", ["blocks", "relates", "duplicates"]]],
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
  it(`keeps exact JSON-RPC, owned Pi, and pinned OpenAI wrapper manifests under ${MAX_MANIFEST_TOKENS} o200k_base tokens`, async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const wrappers = {
      rpc: { jsonrpc: "2.0", id: 1, result: { tools } },
      pi: { tools: projectPiToolManifest(tools) },
      // Pinned provider fixture: OpenAI Responses API function tool shape (2026-07-12).
      openai: { tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", name, description, parameters: inputSchema })) },
    } as const;
    for (const [name, wrapper] of Object.entries(wrappers) as Array<[keyof typeof wrappers, unknown]>) {
      expect(await exactOrAttested(name, JSON.stringify(wrapper))).toBeLessThanOrEqual(MAX_MANIFEST_TOKENS);
    }
  }, 15_000);

  it("fails closed when a 350-character manifest mutation exceeds the cap", async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const prose = sentence.repeat(4).slice(0, 350);
    expect(prose).toHaveLength(350);
    const mutated = { tools: projectPiToolManifest(tools), mutation: prose };
    expect(await exactOrAttested("pi", JSON.stringify(mutated))).toBeGreaterThan(MAX_MANIFEST_TOKENS);
  });

  it("uses attestation only for the unchanged golden when the pinned tokenizer is unavailable", async () => {
    const unavailable: TokenizerLoader = async () => { throw new Error("simulated unavailable tokenizer"); };
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const golden = JSON.stringify({ tools: projectPiToolManifest(tools) });
    expect(await exactOrAttested("pi", golden, unavailable)).toBe(ATTESTED.pi.tokens);

    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const changed = JSON.stringify({ tools: projectPiToolManifest(tools), mutation: sentence.repeat(4).slice(0, 350) });
    await expect(exactOrAttested("pi", changed, unavailable)).rejects.toThrow(/not the attested golden payload/);
  });

  it("keeps tool names, required arrays, and enum arrays stable", () => {
    const tools = buildTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(tools).toHaveLength(59);

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
