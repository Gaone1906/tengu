import { isDeepStrictEqual } from "node:util";
import { logger } from "../shared/logger.js";
import type { Employee, ModelRegistry, WorkflowAttemptCompletion } from "../shared/types.js";
import { interpolateWorkflowPrompt, resolveBinding, WorkflowBindingError, type WorkflowBindingContext } from "./bindings.js";
import { buildNodeContract } from "./contract.js";
import type {
  ConditionNode,
  ConditionPredicate,
  EmployeeNode,
  JsonValue,
  ApprovalNode,
  WaitNode,
  WorkflowNode,
  WorkflowNodeOutput,
} from "./model.js";
import { parseWorkflowOutput, validateSubmittedFields, WorkflowOutputError } from "./output.js";
import { WorkflowRepositoryError, type WorkflowRepository } from "./repository.js";
import type { ResolvedEmployeeConfig, WorkflowError, WorkflowNodeRunRecord, WorkflowRunDetail } from "./runtime.js";
import type { WorkflowSessionExecutor } from "./session-executor.js";
import { topologicalOrder, validateExecutableWorkflow } from "./validation.js";

export interface WorkflowRunnerOptions {
  repository: WorkflowRepository;
  executor: WorkflowSessionExecutor;
  employees: () => ReadonlyMap<string, Employee>;
  models: () => ModelRegistry;
  now?: () => string;
  onChange?: (change: { workflowId: string; runId: string }) => void;
  /** Mirrors an Approval node's gate onto the run's bound Todo so the operator
   *  decides it from Todos, not from Workflows. Absent = no Todo surface (the
   *  gate still parks the run and is decidable through the workflow API). */
  todoApprovals?: WorkflowTodoApprovalMirror;
  /** Links each phase session to the run's bound Todo so the run's spend rolls
   *  up on that Todo. Absent = no attribution (the run still executes). */
  todoSessions?: WorkflowTodoSessionLink;
}

export interface WorkflowTodoApprovalMirror {
  request(input: { todoId: string; request: string; ref: string; options?: string[]; approver?: string }): void;
}

export interface WorkflowTodoSessionLink {
  link(input: { todoId: string; sessionId: string }): void;
}

type NodeAction =
  | { kind: "activate" | "skip" | "condition" | "merge" | "approval" | "wait" | "end"; node: WorkflowNode }
  | { kind: "dispatch"; node: EmployeeNode; config: ResolvedEmployeeConfig };
const REMINDER_RUNGS_MINUTES = [5, 15, 30] as const;
const REMINDER_TEXT = "Workflow reminder: if you have finished this step, call `workflow_submit_output` now. If you are still working or waiting on delegated work, continue.";
const FINAL_REMINDER_TEXT = `${REMINDER_TEXT} This is the final reminder. If you genuinely need more time, call \`workflow_extend_deadline\`.`;
function addMinutes(at: string, minutes: number): string {
  return new Date(Date.parse(at) + minutes * 60_000).toISOString();
}
function hasWorkflowOutputBlock(text: string): boolean {
  return /(?:^|\n)```jinn-output[ \t]*(?:\r?\n|$)/.test(text);
}
function workflowError(error: unknown, nodeId: string, attempt?: number): WorkflowError {
  const value = error instanceof Error ? error : new Error(String(error));
  return { code: "workflow-step-failed", message: value.message, retryable: false, nodeId, ...(attempt ? { attempt } : {}) };
}
function bindingContext(run: WorkflowRunDetail): WorkflowBindingContext {
  return {
    input: run.input,
    trigger: { kind: run.trigger.kind, payload: run.trigger.payload },
    run: { id: run.id, startedAt: run.startedAt, ...(run.trigger.todoId ? { todoId: run.trigger.todoId } : {}) },
    nodes: Object.fromEntries(run.nodeRuns.map((node) => [node.nodeId, {
      status: node.status, output: node.output ?? null, error: node.error ?? null,
    }])),
  };
}
function upstreamSessions(run: WorkflowRunDetail, nodeId: string): Array<{ nodeId: string; sessionId?: string }> {
  const ancestors = new Set<string>();
  const pending = incoming(run, nodeId).map((edge) => edge.from.nodeId);
  while (pending.length > 0) {
    const upstreamId = pending.pop()!;
    if (ancestors.has(upstreamId)) continue;
    ancestors.add(upstreamId);
    pending.push(...incoming(run, upstreamId).map((edge) => edge.from.nodeId));
  }
  return run.definition.nodes.flatMap((authored) => {
    const runtime = nodeRun(run, authored.id);
    if (!ancestors.has(authored.id) || runtime.status !== "completed") return [];
    const attempt = run.attempts.filter((candidate) => candidate.nodeId === authored.id
      && candidate.status === "completed" && candidate.sessionId).at(-1);
    const sessionId = runtime.output?.sessionId ?? attempt?.sessionId;
    return [{ nodeId: authored.id, ...(sessionId ? { sessionId } : {}) }];
  });
}
function composeEmployeePrompt(run: WorkflowRunDetail, node: EmployeeNode): string {
  const prompt = interpolateWorkflowPrompt(node.config.prompt, bindingContext(run));
  return `${prompt}\n\n---\n${buildNodeContract(node, upstreamSessions(run, node.id))}`;
}
function resolveString(binding: Parameters<typeof resolveBinding<string>>[0], context: WorkflowBindingContext, label: string): string {
  const value = resolveBinding(binding, context);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must resolve to a nonempty string.`);
  return value;
}
function resolveDispatch(run: WorkflowRunDetail, node: EmployeeNode, options: WorkflowRunnerOptions): ResolvedEmployeeConfig {
  const context = bindingContext(run);
  const employeeId = resolveString(node.config.employee, context, "Employee");
  const employee = options.employees().get(employeeId);
  if (!employee) throw new Error(`Workflow employee "${employeeId}" is not available.`);
  const engine = node.config.engine ? resolveString(node.config.engine, context, "Engine") : employee.engine;
  const registry = options.models()[engine];
  if (!registry?.available) throw new Error(`Workflow engine "${engine}" is not available.`);
  const model = node.config.model ? resolveString(node.config.model, context, "Model") : node.config.engine ? registry.defaultModel : employee.model || registry.defaultModel;
  const modelInfo = registry.models.find((candidate) => candidate.id === model);
  if (!modelInfo) throw new Error(`Workflow model "${model}" is not available for engine "${engine}".`);
  const rawEffort = node.config.effort ? resolveString(node.config.effort, context, "Effort") : (node.config.engine || node.config.model) ? undefined : employee.effortLevel;
  const effort = rawEffort as ResolvedEmployeeConfig["effort"];
  if (effort && (!modelInfo.supportsEffort || !modelInfo.effortLevels.includes(effort))) {
    throw new Error(`Workflow effort "${effort}" is not available for model "${model}".`);
  }
  interpolateWorkflowPrompt(node.config.prompt, context);
  const config: ResolvedEmployeeConfig = {
    employeeId, engine, model, ...(effort ? { effort } : {}),
    retry: node.config.retry ?? { attempts: 1, delaySeconds: 0, backoff: "fixed" },
    ...(node.config.timeoutMinutes === undefined ? {} : { timeoutMinutes: node.config.timeoutMinutes }),
  };
  return config;
}
function nodeRun(run: WorkflowRunDetail, nodeId: string): WorkflowNodeRunRecord {
  const found = run.nodeRuns.find((node) => node.nodeId === nodeId);
  if (!found) throw new Error(`Workflow node ${nodeId} was not found.`);
  return found;
}
function incoming(run: WorkflowRunDetail, nodeId: string) {
  return run.definition.edges.filter((edge) => edge.to.nodeId === nodeId);
}
function terminalNode(node: WorkflowNodeRunRecord): boolean {
  return ["completed", "failed", "skipped", "cancelled"].includes(node.status);
}
function edgeActivated(run: WorkflowRunDetail, edge: WorkflowRunDetail["definition"]["edges"][number]): boolean {
  const source = run.definition.nodes.find((node) => node.id === edge.from.nodeId)!;
  const runtime = nodeRun(run, source.id);
  if (!runtime.activated) return false;
  if (runtime.status === "failed" && source.type === "employee") return edge.from.port === "error";
  if (runtime.status !== "completed") return false;
  const port = source.type === "condition" || source.type === "approval" ? runtime.output?.fields.port : "success";
  return port === edge.from.port;
}
function activationPossible(run: WorkflowRunDetail, nodeId: string, seen = new Set<string>()): boolean {
  const runtime = nodeRun(run, nodeId);
  if (runtime.activated) return true;
  if (runtime.status === "skipped" || runtime.status === "cancelled" || seen.has(nodeId)) return false;
  const path = new Set(seen).add(nodeId);
  return incoming(run, nodeId).some((edge) => {
    const source = nodeRun(run, edge.from.nodeId);
    if (!source.activated) return activationPossible(run, edge.from.nodeId, path);
    return terminalNode(source) ? edgeActivated(run, edge) : true;
  });
}
function canNeverActivate(run: WorkflowRunDetail, nodeId: string): boolean {
  return incoming(run, nodeId).length > 0 && !activationPossible(run, nodeId);
}
function mergeReady(run: WorkflowRunDetail, nodeId: string): boolean {
  return incoming(run, nodeId).every((edge) => {
    const source = nodeRun(run, edge.from.nodeId);
    return source.activated ? terminalNode(source) : !activationPossible(run, edge.from.nodeId);
  });
}
function resolved(binding: ConditionPredicate["left"], context: WorkflowBindingContext): { exists: boolean; value?: JsonValue } {
  try { return { exists: true, value: resolveBinding(binding, context) }; }
  catch (error) {
    if (error instanceof WorkflowBindingError && error.code === "missing-value") return { exists: false };
    throw error;
  }
}
function predicateMatches(predicate: ConditionPredicate, context: WorkflowBindingContext): boolean {
  const left = resolved(predicate.left, context);
  if (predicate.operator === "exists") return left.exists;
  if (predicate.operator === "not-exists") return !left.exists;
  if (!left.exists || !predicate.right) return false;
  const right = resolved(predicate.right, context);
  if (!right.exists) return false;
  if (predicate.operator === "equals") return isDeepStrictEqual(left.value, right.value);
  if (predicate.operator === "not-equals") return !isDeepStrictEqual(left.value, right.value);
  if (predicate.operator === "contains") return typeof left.value === "string" && typeof right.value === "string"
    ? left.value.includes(right.value) : Array.isArray(left.value) && left.value.some((item) => isDeepStrictEqual(item, right.value));
  if (predicate.operator === "in") return typeof right.value === "string" && typeof left.value === "string"
    ? right.value.includes(left.value) : Array.isArray(right.value) && right.value.some((item) => isDeepStrictEqual(item, left.value));
  if (typeof left.value !== "number" || typeof right.value !== "number") return false;
  return predicate.operator === "gt" ? left.value > right.value
    : predicate.operator === "gte" ? left.value >= right.value
      : predicate.operator === "lt" ? left.value < right.value : left.value <= right.value;
}
function conditionPort(run: WorkflowRunDetail, node: ConditionNode): string {
  const context = bindingContext(run);
  return node.config.cases.find((item) => item.all.every((predicate) => predicateMatches(predicate, context)))?.port
    ?? node.config.defaultPort;
}
function inputFor(run: WorkflowRunDetail, nodeId: string): JsonValue {
  const outputs = incoming(run, nodeId).filter((edge) => edgeActivated(run, edge))
    .map((edge) => nodeRun(run, edge.from.nodeId).output).filter((output): output is WorkflowNodeOutput => output !== undefined);
  return outputs.length === 1 ? outputs[0] as unknown as JsonValue : run.input;
}
function mergeOutput(run: WorkflowRunDetail, nodeId: string): WorkflowNodeOutput {
  const values = incoming(run, nodeId).filter((edge) => edgeActivated(run, edge)).map((edge) => {
    const output = nodeRun(run, edge.from.nodeId).output;
    return [edge.from.nodeId, output ?? { text: "", fields: {} }] as const;
  });
  return { text: "", fields: { byNode: Object.fromEntries(values) as unknown as JsonValue } };
}
function approvalRef(run: WorkflowRunDetail, node: ApprovalNode): string | undefined {
  return node.config.approver ? resolveString(node.config.approver, bindingContext(run), "Workflow approver") : undefined;
}
/** Stable correlation key tying a Todo approval back to the node that parked. */
export function todoApprovalRef(run: Pick<WorkflowRunDetail, "workflowId" | "id">, nodeId: string): string {
  return `workflow:${run.workflowId}:${run.id}:${nodeId}`;
}
export function parseTodoApprovalRef(ref: string | null): { workflowId: string; runId: string; nodeId: string } | null {
  const parts = ref?.split(":") ?? [];
  if (parts.length !== 4 || parts[0] !== "workflow") return null;
  return { workflowId: parts[1]!, runId: parts[2]!, nodeId: parts[3]! };
}
function waitResumeAt(run: WorkflowRunDetail, node: WaitNode, now: string): string {
  if (node.config.mode === "duration") return new Date(Date.parse(now) + node.config.minutes * 60_000).toISOString();
  const value = resolveBinding(node.config.timestamp, bindingContext(run));
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Workflow Wait timestamp must resolve to a canonical instant.");
  }
  return value;
}
export class WorkflowRunner {
  constructor(private readonly options: WorkflowRunnerOptions) {}
  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }
  private detail(workflowId: string, runId: string): WorkflowRunDetail {
    const run = this.options.repository.getRun(workflowId, runId);
    if (!run) throw new Error(`Workflow run ${runId} was not found.`);
    return run;
  }
  private changed(run: Pick<WorkflowRunDetail, "workflowId" | "id">): void {
    this.options.onChange?.({ workflowId: run.workflowId, runId: run.id });
  }
  private failRun(run: WorkflowRunDetail, error: unknown, nodeId = run.trigger.nodeId): WorkflowRunDetail {
    const endedAt = this.now();
    const failure = workflowError(error, nodeId);
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setRunStatus("failed", { endedAt, error: failure });
      const runtime = nodeRun(run, nodeId);
      if (!terminalNode(runtime)) tx.setNodeStatus(nodeId, "failed", { activated: true, error: failure, startedAt: endedAt, endedAt });
    });
    this.changed(run);
    return this.detail(run.workflowId, run.id);
  }

  async start(runId: string): Promise<WorkflowRunDetail> {
    const record = this.options.repository.listRecoverableRuns().find((candidate) => candidate.id === runId);
    if (!record) throw new Error(`Workflow run ${runId} was not found.`);
    const run = this.detail(record.workflowId, record.id);
    if (run.status !== "pending") return run;
    const validation = validateExecutableWorkflow(run.definition);
    if (!run.definition.enabled || !validation.ok) return this.failRun(run, new Error("Workflow is not enabled and executable."));
    const trigger = run.definition.nodes.find((node) => node.id === run.trigger.nodeId)!;
    const endedAt = this.now();
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setRunStatus("running");
      tx.setNodeStatus(trigger.id, "completed", { activated: true, startedAt: run.startedAt, endedAt });
    });
    this.changed(run);
    return this.advance(run.workflowId, run.id);
  }

  private nextAction(run: WorkflowRunDetail): NodeAction | null {
    for (const id of topologicalOrder(run.definition)) {
      const node = run.definition.nodes.find((candidate) => candidate.id === id)!;
      const runtime = nodeRun(run, id);
      if (node.type === "trigger" || runtime.status !== "pending") continue;
      if (!runtime.activated && incoming(run, id).some((edge) => edgeActivated(run, edge))) return { kind: "activate", node };
      if (!runtime.activated && canNeverActivate(run, id)) return { kind: "skip", node };
      if (!runtime.activated) continue;
      if (node.type === "employee") {
        try { return { kind: "dispatch", node, config: resolveDispatch(run, node, this.options) }; }
        catch (error) { this.failRun(run, error, node.id); return null; }
      }
      if (node.type === "condition") return { kind: "condition", node };
      if (node.type === "merge" && mergeReady(run, node.id)) return { kind: "merge", node };
      if (node.type === "approval") return { kind: "approval", node };
      if (node.type === "wait") return { kind: "wait", node };
      if (node.type === "end") return { kind: "end", node };
    }
    return null;
  }

  private applyInline(run: WorkflowRunDetail, action: Exclude<NodeAction, { kind: "dispatch" }>): void {
    const at = this.now();
    let approver: string | undefined;
    let resumeAt: string | undefined;
    if (action.kind === "approval") approver = approvalRef(run, action.node as ApprovalNode);
    if (action.kind === "wait") resumeAt = waitResumeAt(run, action.node as WaitNode, at);
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      if (action.kind === "activate") tx.setNodeStatus(action.node.id, "pending", { activated: true, input: inputFor(run, action.node.id) });
      else if (action.kind === "skip") tx.setNodeStatus(action.node.id, "skipped", { endedAt: at });
      else if (action.kind === "condition") {
        const port = conditionPort(run, action.node as ConditionNode);
        tx.setNodeStatus(action.node.id, "completed", { output: { text: "", fields: { port } }, startedAt: at, endedAt: at });
      } else if (action.kind === "merge") {
        tx.setNodeStatus(action.node.id, "completed", { output: mergeOutput(run, action.node.id), startedAt: at, endedAt: at });
      } else if (action.kind === "approval") {
        tx.putApproval({ nodeId: action.node.id, status: "pending", requestedAt: at, ...(approver ? { approverRef: approver } : {}) });
        tx.setNodeStatus(action.node.id, "waiting", { startedAt: at });
        tx.setRunStatus("waiting");
        this.mirrorApproval(run, action.node as ApprovalNode, approver);
      } else if (action.kind === "wait") {
        tx.setNodeStatus(action.node.id, "waiting", { resumeAt, startedAt: at });
        tx.setRunStatus("waiting");
      } else {
        tx.setNodeStatus(action.node.id, "completed", { startedAt: at, endedAt: at });
        if (action.node.type === "end" && action.node.config.result === "failure") {
          tx.setRunStatus("failed", { endedAt: at, error: { code: "workflow-failure-end",
            message: `Workflow reached failure End ${action.node.id}.`, retryable: false, nodeId: action.node.id } });
        }
      }
    });
    this.changed(run);
  }

  /** Mirror a parked gate onto the run's bound Todo (Gap 2: the operator picks
   *  and approves from Todos). Best-effort — a mirror failure must not fail a
   *  run whose gate is already parked and decidable through the workflow API. */
  private mirrorApproval(run: WorkflowRunDetail, node: ApprovalNode, approver: string | undefined): void {
    if (!run.trigger.todoId || !this.options.todoApprovals) return;
    try {
      this.options.todoApprovals.request({ todoId: run.trigger.todoId, request: node.config.description,
        ref: todoApprovalRef(run, node.id), ...(node.config.options ? { options: node.config.options } : {}),
        ...(approver ? { approver } : {}) });
    } catch { /* the workflow-side gate stands on its own */ }
  }

  /** Attribute a phase session to the run's bound Todo, so the Todo's derived
   *  spend covers what the pipeline cost — it sums `total_cost` over its linked
   *  sessions, and until now a run's phases were linked to nothing. Best-effort:
   *  the attempt is already dispatched and the Todo may have been deleted since
   *  the run started, so a failure is logged rather than failing the run. */
  private attributeSession(run: WorkflowRunDetail, sessionId: string): void {
    const todoId = run.trigger.todoId;
    if (!todoId || !this.options.todoSessions) return;
    try {
      this.options.todoSessions.link({ todoId, sessionId });
    } catch (error) {
      logger.warn(`Workflow run ${run.id} could not attribute session ${sessionId} to Todo ${todoId}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async dispatch(run: WorkflowRunDetail, node: EmployeeNode, config: ResolvedEmployeeConfig): Promise<void> {
    const at = this.now();
    const promptText = composeEmployeePrompt(run, node);
    const attempt = this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setNodeStatus(node.id, "dispatching", { resolvedConfig: config as unknown as Record<string, JsonValue>,
        input: inputFor(run, node.id), startedAt: at });
      return tx.createAttempt({ nodeId: node.id, resolvedConfig: config, input: inputFor(run, node.id), promptText });
    });
    this.changed(run);
    try {
      await this.recoverDispatching(run.workflowId, run.id, node.id, attempt.attempt);
    } catch (error) {
      const current = this.detail(run.workflowId, run.id);
      const endedAt = this.now();
      const failure = workflowError(error, node.id, attempt.attempt);
      const stored = current.attempts.find((item) => item.nodeId === node.id && item.attempt === attempt.attempt)!;
      if (this.settleFailure(current, stored, failure, "failed", endedAt)) await this.advance(run.workflowId, run.id);
    }
  }

  private finish(run: WorkflowRunDetail): boolean {
    const active = run.nodeRuns.some((node) => node.activated && !terminalNode(node));
    const successfulEnd = run.definition.nodes.some((node) => node.type === "end" && node.config.result === "success"
      && nodeRun(run, node.id).status === "completed");
    if (active || !successfulEnd || run.status !== "running") return false;
    const endedAt = this.now();
    this.options.repository.mutateRun(run.id, run.revision, (tx) => tx.setRunStatus("completed", { endedAt }));
    this.changed(run);
    return true;
  }

  private async advance(workflowId: string, runId: string): Promise<WorkflowRunDetail> {
    const max = this.detail(workflowId, runId).definition.nodes.length * 4 + 4;
    for (let index = 0; index < max; index += 1) {
      const run = this.detail(workflowId, runId);
      if (["completed", "failed", "cancelled"].includes(run.status)) return run;
      const action = this.nextAction(run);
      if (!action) {
        if (this.finish(run)) continue;
        return this.detail(workflowId, runId);
      }
      if (action.kind === "dispatch") await this.dispatch(run, action.node, action.config);
      else this.applyInline(run, action);
    }
    return this.failRun(this.detail(workflowId, runId), new Error("Workflow control flow did not settle."));
  }

  async resumeWait(workflowId: string, runId: string, nodeId: string, now: string): Promise<boolean> {
    const run = this.detail(workflowId, runId);
    const runtime = nodeRun(run, nodeId);
    const authored = run.definition.nodes.find((node) => node.id === nodeId);
    const resumableEmployee = authored?.type === "employee" && runtime.status === "waiting";
    if (run.status !== "waiting" || (authored?.type !== "wait" && !resumableEmployee)
      || runtime.status !== "waiting" || !runtime.resumeAt || runtime.resumeAt > now) return false;
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      if (resumableEmployee) tx.setNodeStatus(nodeId, "pending", { activated: true });
      else tx.setNodeStatus(nodeId, "completed", { output: { text: "", fields: {} }, endedAt: now });
      tx.setRunStatus("running");
    });
    this.changed(run);
    await this.advance(workflowId, runId);
    return true;
  }

  async recoverDispatching(workflowId: string, runId: string, nodeId: string, attemptNumber: number): Promise<boolean> {
    const run = this.detail(workflowId, runId);
    const attempt = run.attempts.find((item) => item.nodeId === nodeId && item.attempt === attemptNumber);
    const node = run.definition.nodes.find((item): item is EmployeeNode => item.id === nodeId && item.type === "employee");
    if (!attempt || attempt.status !== "dispatching" || !node) return false;
    // Prefer the prompt persisted at attempt creation so the session receives
    // exactly what the run detail shows; recompose only for attempts that
    // predate the column.
    const prompt = attempt.promptText ?? composeEmployeePrompt(run, node);
    const config = attempt.resolvedConfig;
    const { sessionId } = await this.options.executor.startAttempt({ owner: { workflowId, runId, nodeId, attempt: attemptNumber },
      employeeId: config.employeeId, engine: config.engine, ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {}), prompt });
    const current = this.detail(workflowId, runId);
    this.options.repository.mutateRun(runId, current.revision, (tx) => {
      tx.settleAttempt(nodeId, attemptNumber, { status: "running", sessionId });
      tx.setNodeStatus(nodeId, "running");
    });
    this.attributeSession(current, sessionId);
    this.changed(current);
    return true;
  }

  async timeoutAttempt(workflowId: string, runId: string, nodeId: string, attemptNumber: number, at: string): Promise<boolean> {
    const run = this.detail(workflowId, runId);
    const attempt = run.attempts.find((item) => item.nodeId === nodeId && item.attempt === attemptNumber);
    if (!attempt || attempt.status !== "running") return false;
    const error: WorkflowError = { code: "workflow-timeout", message: "Workflow attempt timed out.", retryable: true,
      nodeId, attempt: attemptNumber };
    this.settleFailure(run, attempt, error, "timed-out", at);
    return true;
  }

  async retryNode(workflowId: string, runId: string, nodeId: string, idempotencyKey: string): Promise<WorkflowRunDetail> {
    const run = this.detail(workflowId, runId);
    const replay = this.options.repository.findAttemptByRetryKey(run.id, idempotencyKey);
    if (replay) return this.detail(workflowId, runId);
    const latest = run.attempts.filter((attempt) => attempt.nodeId === nodeId).at(-1);
    if (!latest) throw new Error(`Workflow Employee ${nodeId} has no retryable attempt.`);
    const authored = run.definition.nodes.find((item): item is EmployeeNode => item.id === nodeId && item.type === "employee");
    const promptText = authored ? composeEmployeePrompt(run, authored) : undefined;
    try {
      this.options.repository.mutateRun(run.id, run.revision, (tx) => {
        tx.setNodeStatus(nodeId, "dispatching", { activated: true });
        tx.setRunStatus("running");
        tx.createAttempt({ nodeId, resolvedConfig: latest.resolvedConfig,
          input: latest.input, ...(promptText === undefined ? {} : { promptText }), retryIdempotencyKey: idempotencyKey });
      });
    } catch (error) {
      const claimed = this.options.repository.findAttemptByRetryKey(run.id, idempotencyKey);
      if (claimed?.nodeId === nodeId && error instanceof WorkflowRepositoryError
        && error.code === "revision-conflict") return this.detail(workflowId, runId);
      throw error;
    }
    this.changed(run);
    const attempt = this.options.repository.findAttemptByRetryKey(run.id, idempotencyKey)!;
    await this.recoverDispatching(workflowId, runId, nodeId, attempt.attempt);
    return this.detail(workflowId, runId);
  }

  async decideApproval(input: {
    workflowId: string; runId: string; nodeId: string; decision: "approve" | "reject";
    decidedBy: string; reason?: string; choice?: string; expectedRevision: number;
  }): Promise<WorkflowRunDetail> {
    const run = this.detail(input.workflowId, input.runId);
    const at = this.now();
    const status = input.decision === "approve" ? "approved" : "rejected";
    const routed = run.definition.edges.some((edge) => edge.from.nodeId === input.nodeId && edge.from.port === status);
    const missingRoute: WorkflowError = { code: "workflow-approval-route-missing",
      message: `Workflow approval ${input.nodeId} has no ${status} route.`, retryable: false, nodeId: input.nodeId };
    this.options.repository.mutateRun(run.id, input.expectedRevision, (tx) => {
      const pending = run.approvals.find((approval) => approval.nodeId === input.nodeId)!;
      tx.putApproval({ nodeId: pending.nodeId, requestedAt: pending.requestedAt,
        ...(pending.approverRef ? { approverRef: pending.approverRef } : {}), status,
        decidedAt: at, decidedBy: input.decidedBy, decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}) });
      if (routed) {
        tx.setNodeStatus(input.nodeId, "completed", { output: { text: input.choice ?? "", fields: { port: status },
          ...(input.choice !== undefined ? { choice: input.choice } : {}) }, endedAt: at });
        tx.setRunStatus("running");
      } else {
        tx.setNodeStatus(input.nodeId, "failed", { error: missingRoute, endedAt: at });
        tx.setRunStatus("failed", { error: missingRoute, endedAt: at });
      }
    });
    this.changed(run);
    return routed ? this.advance(input.workflowId, input.runId) : this.detail(input.workflowId, input.runId);
  }

  private settleFailure(run: WorkflowRunDetail, attempt: typeof run.attempts[number], error: WorkflowError,
    status: "failed" | "timed-out" | "cancelled", endedAt: string, processedTurn?: number): boolean {
    const retry = attempt.attempt < attempt.resolvedConfig.retry.attempts;
    const routed = !retry && run.definition.edges.some((edge) => edge.from.nodeId === attempt.nodeId && edge.from.port === "error");
    const failure = retry ? { ...error, retryable: true } : error;
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      if (processedTurn !== undefined) {
        tx.setAttemptReminder(attempt.nodeId, attempt.attempt, { lastProcessedTurn: processedTurn });
      }
      tx.settleAttempt(attempt.nodeId, attempt.attempt, { status,
        ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}), error: failure, endedAt });
      if (retry) {
        const factor = attempt.resolvedConfig.retry.backoff === "exponential" ? 2 ** (attempt.attempt - 1) : 1;
        const resumeAt = new Date(Date.parse(endedAt)
          + Math.min(600, attempt.resolvedConfig.retry.delaySeconds * factor) * 1000).toISOString();
        tx.setNodeStatus(attempt.nodeId, "waiting", { error: failure,
          resumeAt, endedAt });
        tx.setRunStatus("waiting");
      } else {
        tx.setNodeStatus(attempt.nodeId, "failed", { error: failure, endedAt });
        if (routed) tx.setRunStatus("running");
        else tx.setRunStatus("failed", { error: failure, endedAt });
      }
    });
    this.changed(run);
    return routed;
  }

  private activeRunForAttempt(attempt: WorkflowRunDetail["attempts"][number]): WorkflowRunDetail {
    const record = this.options.repository.listRecoverableRuns().find((candidate) => candidate.id === attempt.runId);
    if (!record) {
      throw new WorkflowRepositoryError("corrupt-record", `Workflow attempt ${attempt.nodeId}:${attempt.attempt} has no active run.`);
    }
    return this.detail(record.workflowId, record.id);
  }

  private alreadySubmitted(sessionId: string): never {
    throw new WorkflowRepositoryError("already-submitted", `Workflow attempt session ${sessionId} already submitted.`);
  }

  async remindDueAttempts(now: string): Promise<void> {
    for (const due of this.options.repository.listDueReminders(now, 100)) {
      const current = this.options.repository.getAttempt(due.runId, due.nodeId, due.attempt);
      if (!current || current.status !== "running" || !current.sessionId
        || !current.nextReminderAt || current.nextReminderAt > now) continue;
      const run = this.activeRunForAttempt(current);
      const state = this.options.executor.attemptState(current.sessionId);
      if (!state?.idle || state.runningChildren > 0) {
        this.options.repository.mutateRun(run.id, run.revision, (tx) => {
          tx.setAttemptReminder(current.nodeId, current.attempt, { nextReminderAt: addMinutes(now, 5) });
        });
        this.changed(run);
        continue;
      }
      const rung = current.remindersSent + 1;
      const reminder = rung === 3 ? FINAL_REMINDER_TEXT : REMINDER_TEXT;
      const text = current.pendingOutputError
        ? `Your previous output block was invalid: ${current.pendingOutputError}\n\n${reminder}`
        : reminder;
      await this.options.executor.remind({ sessionId: current.sessionId, text });
      const refreshed = this.activeRunForAttempt(current);
      const latest = refreshed.attempts.find((candidate) => candidate.nodeId === current.nodeId
        && candidate.attempt === current.attempt);
      if (!latest || latest.status !== "running") continue;
      this.options.repository.mutateRun(refreshed.id, refreshed.revision, (tx) => {
        tx.setAttemptReminder(latest.nodeId, latest.attempt, {
          remindersSent: rung,
          nextReminderAt: null,
          pendingOutputError: null,
        });
      });
      this.changed(refreshed);
    }
  }

  async submit(input: {
    sessionId: string;
    outcome?: "success" | "failure";
    fields?: unknown;
    summary?: string;
  }): Promise<WorkflowRunDetail> {
    const attempt = this.options.repository.findAttemptBySessionId(input.sessionId);
    if (!attempt) {
      throw new WorkflowRepositoryError("not-found", `Workflow attempt session ${input.sessionId} was not found.`);
    }
    if (attempt.status !== "running") this.alreadySubmitted(input.sessionId);
    const run = this.activeRunForAttempt(attempt);
    const node = run.definition.nodes.find((candidate): candidate is EmployeeNode =>
      candidate.id === attempt.nodeId && candidate.type === "employee");
    if (!node) throw new WorkflowRepositoryError("corrupt-record", `Workflow attempt ${attempt.nodeId} has no Employee node.`);
    if (input.outcome === "failure") {
      const error: WorkflowError = {
        code: "workflow-submitted-failure",
        message: input.summary ?? "Step reported failure.",
        retryable: true,
        nodeId: attempt.nodeId,
        attempt: attempt.attempt,
      };
      const routed = this.settleFailure(run, attempt, error, "failed", this.now());
      return routed ? this.advance(run.workflowId, run.id) : this.detail(run.workflowId, run.id);
    }
    const fields = validateSubmittedFields(input.fields, node.config.output);
    const output: WorkflowNodeOutput = {
      text: input.summary ?? "",
      fields,
      employeeId: attempt.resolvedConfig.employeeId,
      engine: attempt.resolvedConfig.engine,
      ...(attempt.resolvedConfig.model ? { model: attempt.resolvedConfig.model } : {}),
      sessionId: input.sessionId,
    };
    try {
      this.options.repository.mutateRun(run.id, run.revision, (tx) => {
        tx.settleAttempt(attempt.nodeId, attempt.attempt, {
          status: "completed",
          sessionId: input.sessionId,
          output,
          endedAt: this.now(),
        });
        tx.setNodeStatus(attempt.nodeId, "completed", { output, endedAt: this.now() });
      });
    } catch (error) {
      if (error instanceof WorkflowRepositoryError && error.code === "revision-conflict"
        && this.options.repository.findAttemptBySessionId(input.sessionId)?.status !== "running") {
        this.alreadySubmitted(input.sessionId);
      }
      throw error;
    }
    this.changed(run);
    return this.advance(run.workflowId, run.id);
  }

  async extend(input: { sessionId: string; reason?: string }): Promise<void> {
    const attempt = this.options.repository.findAttemptBySessionId(input.sessionId);
    if (!attempt) {
      throw new WorkflowRepositoryError("not-found", `Workflow attempt session ${input.sessionId} was not found.`);
    }
    if (attempt.status !== "running") this.alreadySubmitted(input.sessionId);
    const run = this.activeRunForAttempt(attempt);
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setAttemptReminder(attempt.nodeId, attempt.attempt, {
        remindersSent: 0,
        nextReminderAt: null,
        extensions: attempt.extensions + 1,
        lastExtensionReason: input.reason ?? null,
        pendingOutputError: null,
      });
    });
    this.changed(run);
  }

  async complete(event: WorkflowAttemptCompletion): Promise<boolean> {
    const attempt = this.options.repository.findAttemptBySessionId(event.sessionId);
    if (!attempt || attempt.status !== "running" || event.terminalVersion < 1
      || !Number.isInteger(event.turn) || event.turn < 1 || event.turn <= attempt.lastProcessedTurn) return false;
    const run = this.detail(event.owner.workflowId, event.owner.runId);
    if (attempt.runId !== run.id || attempt.nodeId !== event.owner.nodeId || attempt.attempt !== event.owner.attempt) return false;
    const node = run.definition.nodes.find((candidate): candidate is EmployeeNode => candidate.id === attempt.nodeId && candidate.type === "employee");
    if (!node) return false;
    const cancellation = event.outcome === "interrupted" && run.cancelRequestedAt
      ? { code: "workflow-cancelled", message: event.error ?? "Workflow run cancelled.", retryable: false,
          nodeId: attempt.nodeId, attempt: attempt.attempt } satisfies WorkflowError
      : undefined;
    const userMessageTurnEnd = event.outcome === "interrupted"
      && event.interruptionCause === "user-message"
      && !run.cancelRequestedAt;
    const cleanTurnEnd = event.outcome === "succeeded" || userMessageTurnEnd;
    let output: WorkflowNodeOutput | undefined;
    let failure: WorkflowError | undefined;
    let pendingOutputError: string | undefined;
    if (event.outcome === "succeeded") {
      const finalText = event.finalText ?? "";
      if (hasWorkflowOutputBlock(finalText)) {
        try {
          output = { ...parseWorkflowOutput(finalText, node.config.output), employeeId: attempt.resolvedConfig.employeeId,
            engine: attempt.resolvedConfig.engine, ...(attempt.resolvedConfig.model ? { model: attempt.resolvedConfig.model } : {}), sessionId: event.sessionId };
        } catch (error) {
          if (error instanceof WorkflowOutputError) pendingOutputError = error.message;
          else failure = workflowError(error, attempt.nodeId, attempt.attempt);
        }
      }
    } else if (!userMessageTurnEnd) {
      failure = workflowError(event.error ?? `Workflow attempt was ${event.outcome}.`, attempt.nodeId, attempt.attempt);
    }
    const endedAt = event.completedAt;
    if (cleanTurnEnd && !output && !failure) {
      if (attempt.remindersSent < REMINDER_RUNGS_MINUTES.length) {
        this.options.repository.mutateRun(run.id, run.revision, (tx) => {
          tx.setAttemptReminder(attempt.nodeId, attempt.attempt, {
            nextReminderAt: addMinutes(endedAt, REMINDER_RUNGS_MINUTES[attempt.remindersSent]!),
            ...(pendingOutputError ? { pendingOutputError } : {}),
            lastProcessedTurn: event.turn,
          });
        });
        this.changed(run);
        return true;
      }
      const state = this.options.executor.attemptState(event.sessionId);
      if ((state?.runningChildren ?? 0) > 0) return true;
      const noOutput: WorkflowError = {
        code: "workflow-no-output",
        message: "Workflow attempt ended without submitting output.",
        retryable: true,
        nodeId: attempt.nodeId,
        attempt: attempt.attempt,
      };
      const routed = this.settleFailure(run, attempt, noOutput, "failed", endedAt, event.turn);
      if (routed) await this.advance(run.workflowId, run.id);
      return true;
    }
    if (!output && !cancellation) {
      const routed = this.settleFailure(run, attempt, failure!,
        event.outcome === "interrupted" ? "cancelled" : "failed", endedAt, event.turn);
      if (routed) await this.advance(run.workflowId, run.id);
      return true;
    }
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setAttemptReminder(attempt.nodeId, attempt.attempt, { lastProcessedTurn: event.turn });
      if (cancellation) {
        tx.settleAttempt(attempt.nodeId, attempt.attempt, {
          status: "cancelled", sessionId: event.sessionId, error: cancellation, endedAt,
        });
        tx.setNodeStatus(attempt.nodeId, "cancelled", { error: cancellation, endedAt });
      } else if (output) {
        tx.settleAttempt(attempt.nodeId, attempt.attempt, { status: "completed", sessionId: event.sessionId, output, endedAt });
        tx.setNodeStatus(attempt.nodeId, "completed", { output, endedAt });
      }
    });
    this.changed(run);
    if (output && !cancellation) await this.advance(run.workflowId, run.id);
    return true;
  }
}
