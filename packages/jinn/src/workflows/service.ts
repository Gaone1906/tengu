import { Buffer } from "node:buffer";
import type { Employee, ModelRegistry } from "../shared/types.js";
import type { WorkflowTodoEventFeed } from "../work-items/workflow-event-feed.js";
import { jsonValueSchema, nodeIdSchema, workflowIdSchema, type JsonValue, type WorkflowDefinition, type WorkflowId } from "./model.js";
import {
  WorkflowRepositoryError,
  type CreateWorkflowInput,
  type CursorPage,
  type DefinitionListQuery,
  type RunListQuery,
  type WorkflowDefinitionSummary,
  type WorkflowRepository,
  type WorkflowRunSummary,
} from "./repository.js";
import type { WorkflowError, WorkflowRunDetail } from "./runtime.js";
import { WorkflowRunner, type WorkflowTodoApprovalMirror, type WorkflowTodoLifecycle, type WorkflowTodoSessionLink } from "./runner.js";
import type { WorkflowSessionExecutor } from "./session-executor.js";
import { WorkflowTriggerService, type FireWorkflowEventInput } from "./trigger-service.js";
import { scheduleTriggerIssues, validateExecutableWorkflow, type WorkflowValidationIssue } from "./validation.js";

export { WorkflowRepositoryError };
export type { FireWorkflowEventInput };

export interface StartWorkflowRunInput {
  workflowId: string;
  input: Record<string, JsonValue>;
  idempotencyKey?: string;
  /** Bind this manual run to an existing Todo, exactly as a `todo-status`
   *  trigger would — its gates mirror onto that Todo. Omit for an unbound run. */
  todoId?: string;
}
export interface RerunWorkflowInput {
  workflowId: string;
  runId: string;
  definition: "original" | "current";
  idempotencyKey: string;
}
export interface DecideWorkflowApprovalInput {
  workflowId: string;
  runId: string;
  nodeId: string;
  decision: "approve" | "reject";
  decidedBy: string;
  reason?: string;
  /** Required when approving a node that offers options; must be one of them. */
  choice?: string;
  expectedRevision: number;
}
export interface RetryWorkflowNodeInput {
  workflowId: string;
  runId: string;
  nodeId: string;
  idempotencyKey: string;
}
export interface WorkflowCallInput {
  workflowId: string;
  caller: { workflowId: string; runId: string; nodeId: string };
  input: Record<string, JsonValue>;
  idempotencyKey: string;
}
export class WorkflowServiceError extends Error {
  readonly code: "forbidden" | "conflict" | "invalid-definition";
  readonly issues?: readonly WorkflowValidationIssue[];

  constructor(code: "forbidden" | "conflict", message: string);
  constructor(code: "invalid-definition", message: string, issues: readonly WorkflowValidationIssue[]);
  constructor(code: "forbidden" | "conflict" | "invalid-definition", message: string,
    issues?: readonly WorkflowValidationIssue[]) {
    super(message);
    this.name = "WorkflowServiceError";
    this.code = code;
    this.issues = issues;
  }
}
export type WorkflowTranscript = Array<{ id: string; role: string; content: string; timestamp: number }>;
export interface WorkflowServiceOptions {
  repository: WorkflowRepository;
  executor: WorkflowSessionExecutor;
  employees: () => ReadonlyMap<string, Employee>;
  models: () => ModelRegistry;
  readTranscript?: (sessionId: string) => WorkflowTranscript;
  now?: () => string;
  onChange?: (change: { workflowId: string; runId: string }) => void;
  onDefinitionChange?: (change: { workflowId: string; revision: number }) => void;
  todoEventFeed?: WorkflowTodoEventFeed;
  /** Mirrors parked Approval gates onto the run's bound Todo (see the runner). */
  todoApprovals?: WorkflowTodoApprovalMirror;
  /** Links phase sessions to the run's bound Todo for spend (see the runner). */
  todoSessions?: WorkflowTodoSessionLink;
  /** Reflects a bound run's own lifecycle onto its Todo (see the runner). */
  todoLifecycle?: WorkflowTodoLifecycle;
  /** Live session-cost aggregate for Workflow attempt sessions. */
  sessionSpend?: (sessionIds: string[]) => number;
}
function fail(code: "bad-input" | "not-found", message: string): never {
  throw new WorkflowRepositoryError(code, message);
}
function boundedRecord(value: unknown, subject: string): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    fail("bad-input", `${subject} must be a JSON object.`);
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 64 * 1024) fail("bad-input", `${subject} is too large.`);
  return parsed.data as Record<string, JsonValue>;
}
function callerIdentity(value: unknown): value is WorkflowCallInput["caller"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return workflowIdSchema.safeParse(record.workflowId).success
    && typeof record.runId === "string" && /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.runId)
    && nodeIdSchema.safeParse(record.nodeId).success;
}
function assertExecutableWorkflow(definition: WorkflowDefinition): void {
  const result = validateExecutableWorkflow(definition);
  if (!result.ok) {
    throw new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", result.issues);
  }
}
export class WorkflowService {
  private readonly runner: WorkflowRunner;
  private readonly triggers: WorkflowTriggerService;
  private unsubscribe: (() => void) | null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: WorkflowServiceOptions) {
    this.runner = new WorkflowRunner({ ...options, onChange: ({ workflowId, runId }) => {
      const run = options.repository.getRun(workflowId, runId);
      if (run) options.onChange?.({ workflowId, runId });
      this.armWakeTimer();
    } });
    this.triggers = new WorkflowTriggerService(options.repository, this.runner,
      () => this.now(), options.todoEventFeed);
    this.unsubscribe = options.executor.subscribe(async (event) => { await this.runner.complete(event); });
    this.armWakeTimer();
  }
  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }
  private definitionChanged(definition: WorkflowDefinition): void {
    this.triggers.rebuild();
    this.options.onDefinitionChange?.({ workflowId: definition.id, revision: definition.revision });
  }
  private runChanged(run: WorkflowRunDetail): void {
    this.options.onChange?.({ workflowId: run.workflowId, runId: run.id });
    this.armWakeTimer();
  }
  private requiredRun(workflowId: string, runId: string): WorkflowRunDetail {
    const run = this.options.repository.getRun(workflowId, runId);
    return run ?? fail("not-found", `Workflow run ${runId} was not found.`);
  }
  private armWakeTimer(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (this.disposed) return;
    const wait = this.options.repository.nextDueWait();
    const reminder = this.options.repository.nextDueReminder();
    const timeout = this.options.repository.nextDueTimeout();
    const nextAt = [wait?.resumeAt, reminder?.nextReminderAt, timeout].filter((value): value is string => Boolean(value)).sort()[0];
    if (!nextAt) return;
    const delay = Math.min(2_147_483_647, Math.max(0, Date.parse(nextAt) - Date.parse(this.now())));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.recover(this.now()).catch(() => { this.armWakeTimer(); });
    }, delay);
    this.wakeTimer.unref?.();
  }
  private validateCaller(targetWorkflowId: string, caller: WorkflowCallInput["caller"]): void {
    let current = this.options.repository.getRun(caller.workflowId, caller.runId)
      ?? fail("bad-input", "Workflow caller run was not found.");
    const attempt = current.attempts.filter((item) => item.nodeId === caller.nodeId).at(-1);
    if (current.definition.nodes.find((node) => node.id === caller.nodeId)?.type !== "employee"
      || !current.nodeRuns.find((node) => node.nodeId === caller.nodeId)?.activated || !attempt
      || !["dispatching", "running"].includes(attempt.status)) {
      fail("bad-input", "Workflow caller node is not an active invocation.");
    }
    const seen = new Set<string>();
    for (let depth = 0; depth < 128; depth += 1) {
      if (current.workflowId === targetWorkflowId) fail("bad-input", "Workflow call recursion is not allowed.");
      if (seen.has(current.id)) fail("bad-input", "Workflow caller ancestry contains a cycle.");
      seen.add(current.id);
      if (current.trigger.kind !== "workflow-call") return;
      const parent = current.trigger.payload.caller;
      if (!callerIdentity(parent)) fail("bad-input", "Workflow caller ancestry is invalid.");
      current = this.options.repository.getRun(parent.workflowId, parent.runId)
        ?? fail("bad-input", "Workflow caller ancestry was not found.");
      if (!current.definition.nodes.some((node) => node.id === parent.nodeId && node.type === "employee")) {
        fail("bad-input", "Workflow caller ancestry is invalid.");
      }
    }
    fail("bad-input", "Workflow caller ancestry is too deep.");
  }

  dispose(): void {
    this.disposed = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.unsubscribe?.(); this.unsubscribe = null; this.triggers.dispose();
  }
  listDefinitions(query: DefinitionListQuery): CursorPage<WorkflowDefinitionSummary> { return this.options.repository.listDefinitions(query); }
  getDefinition(id: string): WorkflowDefinition | null { return this.options.repository.getDefinition(id); }
  getRun(workflowId: string, runId: string): WorkflowRunDetail | null { return this.options.repository.getRun(workflowId, runId); }
  getRunSpend(workflowId: string, runId: string): number {
    const run = this.requiredRun(workflowId, runId);
    const sessionIds = [...new Set(run.attempts.flatMap((attempt) => attempt.sessionId ? [attempt.sessionId] : []))];
    return sessionIds.length > 0 ? (this.options.sessionSpend?.(sessionIds) ?? 0) : 0;
  }
  listRuns(workflowId: string, query: RunListQuery): CursorPage<WorkflowRunSummary> { return this.options.repository.listRuns(workflowId, query); }
  submitAttemptOutput(input: {
    sessionId: string;
    outcome?: "success" | "failure";
    fields?: unknown;
    summary?: string;
  }): Promise<WorkflowRunDetail> {
    return this.runner.submit(input);
  }
  extendAttemptDeadline(input: { sessionId: string; reason?: string }): Promise<void> {
    return this.runner.extend(input);
  }

  createDefinition(input: CreateWorkflowInput): WorkflowDefinition {
    const value = this.options.repository.createDefinition(input); this.definitionChanged(value); return value;
  }
  saveDefinition(definition: WorkflowDefinition, expectedRevision: number): WorkflowDefinition {
    // Saving a revision of an already-enabled Workflow bypasses the enable gate,
    // so an unarmable schedule is refused here before it can become durable.
    const issues = scheduleTriggerIssues(definition);
    if (issues.length > 0) throw new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", issues);
    const value = this.options.repository.saveDefinition(definition, expectedRevision); this.definitionChanged(value); return value;
  }
  duplicateDefinition(sourceId: WorkflowId, input: { id: WorkflowId; title: string }): WorkflowDefinition {
    const value = this.options.repository.duplicateDefinition(sourceId, input); this.definitionChanged(value); return value;
  }
  retireDefinition(input: { id: string; expectedRevision: number }): WorkflowDefinition {
    const value = this.options.repository.retireDefinition(input.id, input.expectedRevision, this.now());
    this.definitionChanged(value); return value;
  }
  setEnabled(input: { id: string; enabled: boolean; expectedRevision: number }): WorkflowDefinition {
    if (input.enabled === true) {
      const current = this.options.repository.getDefinition(input.id)
        ?? fail("not-found", `Workflow definition ${input.id} was not found.`);
      if (current.revision !== input.expectedRevision) {
        throw new WorkflowRepositoryError("revision-conflict", `Workflow definition ${current.id} revision does not match.`);
      }
      if (current.retiredAt !== undefined) {
        throw new WorkflowRepositoryError("retired", `Workflow definition ${current.id} is retired.`);
      }
      assertExecutableWorkflow(current);
    }
    const value = this.options.repository.setEnabled(input.id, input.enabled, input.expectedRevision);
    this.definitionChanged(value); return value;
  }
  async startManual(input: StartWorkflowRunInput): Promise<WorkflowRunDetail> {
    const definition = this.options.repository.getDefinition(input.workflowId);
    if (!definition?.enabled) fail("bad-input", "Workflow does not have an enabled manual trigger.");
    assertExecutableWorkflow(definition);
    const trigger = definition.nodes.find((node) => node.type === "trigger" && node.config.kind === "manual");
    if (!trigger) fail("bad-input", "Workflow does not have an enabled manual trigger.");
    const created = this.options.repository.createRun({ workflowId: definition.id,
      input: boundedRecord(input.input, "Workflow input"),
      trigger: { nodeId: trigger.id, kind: "manual", payload: {}, ...(input.todoId ? { todoId: input.todoId } : {}) },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
    const detail = this.requiredRun(definition.id, created.id);
    return detail.status === "pending" ? this.runner.start(created.id) : detail;
  }
  fireEvent(input: FireWorkflowEventInput): Promise<WorkflowRunDetail[]> { return this.triggers.fire(input); }
  async callWorkflow(input: WorkflowCallInput): Promise<WorkflowRunDetail> {
    const workflowId = workflowIdSchema.safeParse(input.workflowId);
    if (!workflowId.success) fail("bad-input", "Workflow target identity is invalid.");
    if (!callerIdentity(input.caller)) fail("bad-input", "Workflow caller identity is invalid.");
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128) {
      fail("bad-input", "Workflow idempotency key is invalid.");
    }
    const value = boundedRecord(input.input, "Workflow input");
    const replay = this.options.repository.findWorkflowCallByIdempotency({ workflowId: workflowId.data,
      input: value, caller: input.caller, idempotencyKey: input.idempotencyKey });
    if (replay) return this.requiredRun(replay.workflowId, replay.id);
    const definition = this.options.repository.getDefinition(workflowId.data);
    const targets = definition?.nodes.filter((node) => node.type === "trigger" && node.config.kind === "workflow-call") ?? [];
    if (!definition?.enabled || !validateExecutableWorkflow(definition).ok || targets.length !== 1) {
      fail("bad-input", "Workflow target must have one enabled executable workflow-call trigger.");
    }
    this.validateCaller(definition.id, input.caller);
    const created = this.options.repository.createRun({ workflowId: definition.id,
      input: value, trigger: { nodeId: targets[0]!.id, kind: "workflow-call",
        payload: { caller: input.caller } }, idempotencyKey: input.idempotencyKey });
    const detail = this.requiredRun(definition.id, created.id);
    return detail.status === "pending" ? this.runner.start(created.id) : detail;
  }
  getAttemptTranscript(input: { workflowId: string; runId: string; nodeId: string; attempt: number }): WorkflowTranscript {
    this.requiredRun(input.workflowId, input.runId);
    const attempt = this.options.repository.getAttempt(input.runId, input.nodeId, input.attempt);
    if (!attempt) fail("not-found", `Workflow attempt ${input.nodeId}:${input.attempt} was not found.`);
    if (!attempt.sessionId) return [];
    const transcript = this.options.readTranscript?.(attempt.sessionId) ?? [];
    return transcript.map((message) => Object.freeze({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp }));
  }

  async cancelRun(input: { workflowId: string; runId: string; reason: string }): Promise<WorkflowRunDetail> {
    let run = this.requiredRun(input.workflowId, input.runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) fail("bad-input", `Workflow run ${run.id} is already terminal.`);
    if (typeof input.reason !== "string" || input.reason.length > 1000) fail("bad-input", "Workflow cancellation reason is invalid.");
    const requestedAt = this.now();
    this.options.repository.mutateRun(run.id, run.revision, (tx) => tx.setRunStatus(run.status, { cancelRequestedAt: requestedAt }));
    run = this.requiredRun(input.workflowId, input.runId); this.runChanged(run);
    await Promise.allSettled(run.attempts.filter((item) => item.status === "running" && item.sessionId)
      .map((item) => this.options.executor.stopAttempt({ sessionId: item.sessionId!, reason: input.reason || "Workflow run cancelled." })));
    run = this.requiredRun(input.workflowId, input.runId);
    const error: WorkflowError = { code: "workflow-cancelled", message: input.reason || "Workflow run cancelled.", retryable: false };
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      for (const attempt of run.attempts.filter((item) => item.status === "running" || item.status === "dispatching")) {
        tx.settleAttempt(attempt.nodeId, attempt.attempt, { status: "cancelled", ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}), error, endedAt: requestedAt });
      }
      for (const node of run.nodeRuns.filter((item) => !["completed", "failed", "skipped", "cancelled"].includes(item.status))) {
        tx.setNodeStatus(node.nodeId, "cancelled", { error, endedAt: requestedAt });
      }
      tx.setRunStatus("cancelled", { cancelRequestedAt: requestedAt, endedAt: requestedAt, error });
    });
    run = this.requiredRun(input.workflowId, input.runId); this.runChanged(run); return run;
  }

  async rerun(input: RerunWorkflowInput): Promise<WorkflowRunDetail> {
    if (input.definition !== "original" && input.definition !== "current") fail("bad-input", "Workflow rerun definition is invalid.");
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256) fail("bad-input", "Workflow idempotency key is invalid.");
    const source = this.requiredRun(input.workflowId, input.runId);
    const current = this.options.repository.getDefinition(input.workflowId);
    if (!current?.enabled || current.retiredAt) fail("bad-input", "Workflow is not enabled for rerun.");
    const definition = input.definition === "original" ? source.definition : current;
    const created = this.options.repository.createRun({ workflowId: input.workflowId, input: source.input,
      trigger: source.trigger, idempotencyKey: input.idempotencyKey }, definition);
    const detail = this.requiredRun(input.workflowId, created.id);
    return detail.status === "pending" ? this.runner.start(created.id) : detail;
  }

  async decideApproval(input: DecideWorkflowApprovalInput): Promise<WorkflowRunDetail> {
    const run = this.requiredRun(input.workflowId, input.runId);
    if (run.revision !== input.expectedRevision) {
      throw new WorkflowRepositoryError("revision-conflict", `Workflow run ${run.id} revision does not match.`);
    }
    if (!input.decidedBy.trim()) fail("bad-input", "Workflow approval actor is invalid.");
    if (input.decision !== "approve" && input.decision !== "reject") fail("bad-input", "Workflow approval decision is invalid.");
    if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 1000)) {
      fail("bad-input", "Workflow approval reason is invalid.");
    }
    const authored = run.definition.nodes.find((node) => node.id === input.nodeId);
    const approval = run.approvals.find((item) => item.nodeId === input.nodeId);
    if (authored?.type !== "approval" || !approval) fail("not-found", `Workflow approval ${input.nodeId} was not found.`);
    if (approval.status !== "pending") throw new WorkflowServiceError("conflict", `Workflow approval ${input.nodeId} is already decided.`);
    if (authored.config.operatorOnly && input.decidedBy !== "operator") {
      throw new WorkflowServiceError("forbidden", `Workflow approval ${input.nodeId} is operator-only; ${input.decidedBy} cannot decide it.`);
    }
    if (approval.approverRef && input.decidedBy !== approval.approverRef && input.decidedBy !== "operator") {
      throw new WorkflowServiceError("forbidden", `Workflow actor ${input.decidedBy} is not authorized for approval ${input.nodeId}.`);
    }
    const offered = authored.config.options;
    if (input.choice !== undefined) {
      if (input.decision !== "approve") fail("bad-input", "A workflow approval choice requires an approve decision.");
      if (!offered?.includes(input.choice)) fail("bad-input", `Workflow approval ${input.nodeId} does not offer that choice.`);
    } else if (offered && input.decision === "approve") {
      fail("bad-input", `Workflow approval ${input.nodeId} requires choosing one of: ${offered.join(", ")}.`);
    }
    return this.runner.decideApproval(input);
  }

  async retryNode(input: RetryWorkflowNodeInput): Promise<WorkflowRunDetail> {
    const run = this.requiredRun(input.workflowId, input.runId);
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128) {
      fail("bad-input", "Workflow retry idempotency key is invalid.");
    }
    const replay = this.options.repository.findAttemptByRetryKey(run.id, input.idempotencyKey);
    if (replay) {
      if (replay.nodeId !== input.nodeId) {
        throw new WorkflowServiceError("conflict", "Workflow retry idempotency key belongs to a different Employee.");
      }
      return run;
    }
    if (run.status === "completed" || run.status === "cancelled") {
      throw new WorkflowServiceError("conflict", `Workflow run ${run.id} is ${run.status}.`);
    }
    const authored = run.definition.nodes.find((node) => node.id === input.nodeId);
    const runtime = run.nodeRuns.find((node) => node.nodeId === input.nodeId);
    const latest = run.attempts.filter((attempt) => attempt.nodeId === input.nodeId).at(-1);
    if (authored?.type !== "employee" || !runtime || !latest) fail("not-found", `Workflow Employee ${input.nodeId} was not found.`);
    if (latest.status !== "failed" && latest.status !== "timed-out") {
      throw new WorkflowServiceError("conflict", `Workflow Employee ${input.nodeId} is active or already completed.`);
    }
    if (latest.attempt >= latest.resolvedConfig.retry.attempts) fail("bad-input", `Workflow Employee ${input.nodeId} exhausted its retry bounds.`);
    try { return await this.runner.retryNode(input.workflowId, input.runId, input.nodeId, input.idempotencyKey); }
    catch (error) {
      const claimed = this.options.repository.findAttemptByRetryKey(run.id, input.idempotencyKey);
      if (claimed && claimed.nodeId !== input.nodeId) {
        throw new WorkflowServiceError("conflict", "Workflow retry idempotency key belongs to a different Employee.");
      }
      throw error;
    }
  }

  async recover(now: string): Promise<{ resumedRuns: number; resumedWaits: number }> {
    let resumedRuns = 0;
    for (const record of this.options.repository.listRecoverableRuns()) {
      const run = this.requiredRun(record.workflowId, record.id);
      for (const attempt of run.attempts.filter((item) => item.status === "dispatching")) {
        if (await this.runner.recoverDispatching(run.workflowId, run.id, attempt.nodeId, attempt.attempt)) resumedRuns += 1;
      }
      for (const attempt of run.attempts.filter((item) => item.status === "running" && item.sessionId)) {
        const completion = this.options.executor.readTerminalCompletion(attempt.sessionId!);
        if (completion && await this.runner.complete(completion)) { resumedRuns += 1; continue; }
        if (attempt.resolvedConfig.timeoutMinutes !== undefined
          && Date.parse(attempt.startedAt) + attempt.resolvedConfig.timeoutMinutes * 60_000 <= Date.parse(now)) {
          await this.options.executor.stopAttempt({ sessionId: attempt.sessionId!, reason: "Workflow attempt timed out." }).catch(() => undefined);
          if (await this.runner.timeoutAttempt(run.workflowId, run.id, attempt.nodeId, attempt.attempt, now)) resumedRuns += 1;
        }
      }
    }
    let resumedWaits = 0;
    for (const wait of this.options.repository.listDueWaits(now, 100)) {
      const run = this.options.repository.listRecoverableRuns().find((candidate) => candidate.id === wait.runId);
      if (run && await this.runner.resumeWait(run.workflowId, run.id, wait.nodeId, now)) resumedWaits += 1;
    }
    await this.runner.remindDueAttempts(now);
    await this.triggers.recoverTodoEvents();
    this.armWakeTimer();
    return { resumedRuns, resumedWaits };
  }
}
