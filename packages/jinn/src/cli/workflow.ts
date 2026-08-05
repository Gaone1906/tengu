import fs from "node:fs";
import { gatewayBaseUrl } from "../gateway/gateway-info.js";
import { resolveLocalGatewayConnection } from "../gateway/lifecycle.js";
import { describeWorkflowIssues, parseWorkflowIssues, type WorkflowValidationIssue } from "../workflows/issues.js";
import { JINN_HOME } from "../shared/paths.js";

type JsonOptions = { json?: boolean };
type Method = "GET" | "POST" | "PUT";
export interface WorkflowRunResult { runId: string; workflowId: string; status: string; [key: string]: unknown }
export interface WorkflowRequestOptions {
  baseUrl: string; token: string; method: Method; path: string; body?: unknown; fetchImpl?: typeof fetch;
}

export function parseWorkflowInput(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`workflow input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("workflow input must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

/** A gateway rejection that keeps its envelope, so `--json` can print the whole
 *  thing and the plain lane can list which node or edge was refused. */
export class WorkflowRequestError extends Error {
  constructor(message: string, readonly envelope: unknown, readonly issues?: readonly WorkflowValidationIssue[]) {
    super(message);
    this.name = "WorkflowRequestError";
  }
}

export async function requestWorkflow(options: WorkflowRequestOptions): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}`, accept: "application/json" };
  const init: RequestInit = { method: options.method, headers };
  if (options.body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(options.body); }
  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}${options.path}`, init);
  const result = await responseJson(response);
  if (!response.ok) {
    const envelope = result && typeof result === "object" ? result as { code?: unknown; message?: unknown; error?: unknown; issues?: unknown } : {};
    const code = typeof envelope.code === "string" ? `${envelope.code}: ` : "";
    const message = typeof envelope.message === "string" ? envelope.message
      : typeof envelope.error === "string" ? envelope.error : `gateway returned HTTP ${response.status}`;
    throw new WorkflowRequestError(`${code}${message}`, result, parseWorkflowIssues(envelope.issues));
  }
  return result;
}

function connection(): { baseUrl: string; token: string } {
  const info = resolveLocalGatewayConnection(JINN_HOME);
  if (!info.token) throw new Error("Gateway auth token was not found. Start Jinn first, then retry.");
  return { baseUrl: gatewayBaseUrl(info), token: info.token };
}

function fileObject(file: string): Record<string, unknown> {
  return parseWorkflowInput(fs.readFileSync(file, "utf8"));
}
function revision(value: string): number {
  const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error("expected revision must be a positive integer"); return parsed;
}
function query(values: Record<string, unknown>): string {
  const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  const encoded = params.toString(); return encoded ? `?${encoded}` : "";
}
function print(result: unknown, json = false): void {
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (Array.isArray(result)) console.log(`${result.length} Workflow result(s).`);
  else console.log(JSON.stringify(result, null, 2));
}
function failureText(error: unknown, json: boolean): string {
  if (!(error instanceof WorkflowRequestError)) return error instanceof Error ? error.message : String(error);
  return json ? JSON.stringify(error.envelope, null, 2) : describeWorkflowIssues(error.message, error.issues);
}
async function command(method: Method, path: string, body: unknown, options: JsonOptions): Promise<void> {
  try { print(await requestWorkflow({ ...connection(), method, path, ...(body === undefined ? {} : { body }) }), options.json); }
  catch (error) { console.error(failureText(error, options.json === true)); process.exitCode = 1; }
}
const wf = (id: string) => `/api/workflows/${encodeURIComponent(id)}`;
const run = (workflowId: string, runId: string) => `${wf(workflowId)}/runs/${encodeURIComponent(runId)}`;

export async function listWorkflows(options: { cursor?: string; limit?: string } & JsonOptions = {}): Promise<void> {
  return command("GET", `/api/workflows${query({ cursor: options.cursor, limit: options.limit })}`, undefined, options);
}
export async function getWorkflow(workflowId: string, options: JsonOptions = {}): Promise<void> { return command("GET", wf(workflowId), undefined, options); }
export async function createWorkflow(options: { file: string } & JsonOptions): Promise<void> { return command("POST", "/api/workflows", fileObject(options.file), options); }
export async function updateWorkflow(workflowId: string, options: { file: string; expectedRevision: string } & JsonOptions): Promise<void> {
  return command("PUT", wf(workflowId), { definition: fileObject(options.file), expectedRevision: revision(options.expectedRevision) }, options);
}
export async function duplicateWorkflow(sourceId: string, options: { id: string; title: string } & JsonOptions): Promise<void> {
  return command("POST", `${wf(sourceId)}/duplicate`, { id: options.id, title: options.title }, options);
}
export async function retireWorkflow(workflowId: string, options: { expectedRevision: string } & JsonOptions): Promise<void> {
  return command("POST", `${wf(workflowId)}/retire`, { expectedRevision: revision(options.expectedRevision) }, options);
}
export async function enableWorkflow(workflowId: string, options: { expectedRevision: string } & JsonOptions): Promise<void> {
  return command("POST", `${wf(workflowId)}/enable`, { expectedRevision: revision(options.expectedRevision) }, options);
}
export async function disableWorkflow(workflowId: string, options: { expectedRevision: string } & JsonOptions): Promise<void> {
  return command("POST", `${wf(workflowId)}/disable`, { expectedRevision: revision(options.expectedRevision) }, options);
}
export async function startWorkflowRun(workflowId: string, options: { input?: string; idempotencyKey?: string; todoId?: string } & JsonOptions = {}): Promise<void> {
  return command("POST", `${wf(workflowId)}/runs`, { input: options.input ? parseWorkflowInput(options.input) : {},
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.todoId ? { todoId: options.todoId } : {}) }, options);
}
export async function listWorkflowRuns(workflowId: string, options: { cursor?: string; limit?: string; status?: string } & JsonOptions = {}): Promise<void> {
  return command("GET", `${wf(workflowId)}/runs${query({ cursor: options.cursor, limit: options.limit, status: options.status })}`, undefined, options);
}
export async function showWorkflowRun(workflowId: string, runId: string, options: { full?: boolean } & JsonOptions = {}): Promise<void> {
  return command("GET", `${run(workflowId, runId)}${query({ view: options.full ? "full" : undefined })}`, undefined, options);
}
export async function cancelWorkflowRun(workflowId: string, runId: string, options: { reason?: string } & JsonOptions = {}): Promise<void> {
  return command("POST", `${run(workflowId, runId)}/cancel`, options.reason ? { reason: options.reason } : {}, options);
}
export async function rerunWorkflowRun(workflowId: string, runId: string, options: { definition: "original" | "current"; idempotencyKey: string } & JsonOptions): Promise<void> {
  return command("POST", `${run(workflowId, runId)}/rerun`, { definition: options.definition, idempotencyKey: options.idempotencyKey }, options);
}
async function decideWorkflowApproval(decision: "approve" | "reject", workflowId: string, runId: string, nodeId: string,
  options: { expectedRevision: string; reason?: string } & JsonOptions): Promise<void> {
  return command("POST", `${run(workflowId, runId)}/nodes/${encodeURIComponent(nodeId)}/approval`, {
    decision, expectedRevision: revision(options.expectedRevision), ...(options.reason === undefined ? {} : { reason: options.reason }),
  }, options);
}
export async function approveWorkflowApproval(workflowId: string, runId: string, nodeId: string,
  options: { expectedRevision: string; reason?: string } & JsonOptions): Promise<void> {
  return decideWorkflowApproval("approve", workflowId, runId, nodeId, options);
}
export async function rejectWorkflowApproval(workflowId: string, runId: string, nodeId: string,
  options: { expectedRevision: string; reason?: string } & JsonOptions): Promise<void> {
  return decideWorkflowApproval("reject", workflowId, runId, nodeId, options);
}
export async function retryWorkflowNode(workflowId: string, runId: string, nodeId: string,
  options: { idempotencyKey: string } & JsonOptions): Promise<void> {
  return command("POST", `${run(workflowId, runId)}/nodes/${encodeURIComponent(nodeId)}/retry`,
    { idempotencyKey: options.idempotencyKey }, options);
}
export async function fireWorkflowEvent(eventName: string, options: { fireId: string; payload: string } & JsonOptions): Promise<void> {
  return command("POST", `/api/workflows/events/${encodeURIComponent(eventName)}`, { fireId: options.fireId, payload: parseWorkflowInput(options.payload) }, options);
}
