import { Buffer } from "node:buffer";
import cron, { type ScheduledTask } from "node-cron";
import { logger } from "../shared/logger.js";
import { normalizeLabelName } from "../work-items/labels.js";
import { createWorkflowTodoEventFeed, type WorkflowTodoEventClaimOutcome,
  type WorkflowTodoEventFeed, type WorkflowTodoStatusEvent } from "../work-items/workflow-event-feed.js";
import { jsonValueSchema, type JsonValue, type TriggerNode, type WorkflowDefinition } from "./model.js";
import { WorkflowRepositoryError, type WorkflowRepository } from "./repository.js";
import type { WorkflowRunDetail } from "./runtime.js";
import type { WorkflowRunner } from "./runner.js";

export interface FireWorkflowEventInput {
  eventName: string;
  fireId: string;
  payload: Record<string, JsonValue>;
}

interface IndexedTrigger { definition: WorkflowDefinition; trigger: TriggerNode }
interface ScheduleIndex extends IndexedTrigger { task: ScheduledTask }
function bad(message: string): never { throw new WorkflowRepositoryError("bad-input", message); }
function payload(value: unknown): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    bad("Workflow event payload must be a JSON object.");
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 64 * 1024) bad("Workflow event payload must be at most 64 KiB.");
  return parsed.data as Record<string, JsonValue>;
}
function trigger(definition: WorkflowDefinition, kind: TriggerNode["config"]["kind"]): TriggerNode | undefined {
  return definition.nodes.find((node): node is TriggerNode => node.type === "trigger" && node.config.kind === kind);
}
function labelMatches(filter: string, labels: WorkflowTodoStatusEvent["item"]["labels"]): boolean {
  let name: string; try { name = normalizeLabelName(filter); } catch { return false; }
  return labels.some((label) => label.id === filter || label.name === name);
}
/** The reason this Todo event does NOT match the trigger, or undefined when it
 *  does. Filters are ANDed; the first mismatch is what gets reported, so a
 *  suppressed run always says which filter refused it. */
function todoMismatch(node: TriggerNode, event: WorkflowTodoStatusEvent): string | undefined {
  if (node.config.kind !== "todo-status") return "trigger is not a todo-status trigger";
  const { actor, label, department, assignee } = node.config;
  if (actor !== undefined && actor !== event.actor) return `actor ${event.actor ?? "unknown"} is not ${actor}`;
  if (department !== undefined && department !== event.item.department) return `department filter ${department} does not match`;
  if (assignee !== undefined && assignee !== event.item.assignee) return `assignee filter ${assignee} does not match`;
  if (label !== undefined && !labelMatches(label, event.item.labels)) return `label filter ${label} does not match`;
  return undefined;
}
export class WorkflowTriggerService {
  private readonly schedules = new Map<string, ScheduleIndex>();
  private readonly todos = new Map<string, IndexedTrigger[]>();
  private readonly feed: WorkflowTodoEventFeed;

  constructor(private readonly repository: WorkflowRepository, private readonly runner: WorkflowRunner,
    private readonly now: () => string = () => new Date().toISOString(), feed?: WorkflowTodoEventFeed) {
    this.feed = feed ?? createWorkflowTodoEventFeed();
    this.rebuild();
  }
  dispose(): void { for (const item of this.schedules.values()) item.task.stop(); this.schedules.clear(); this.todos.clear(); }

  rebuild(): void {
    this.dispose();
    for (const definition of this.enabledDefinitions()) {
      const schedule = trigger(definition, "schedule");
      if (schedule && schedule.config.kind === "schedule") this.addSchedule(definition, schedule);
      const todo = trigger(definition, "todo-status");
      if (todo && todo.config.kind === "todo-status") {
        const items = this.todos.get(todo.config.status) ?? []; items.push({ definition, trigger: todo });
        this.todos.set(todo.config.status, items);
      }
    }
  }

  async fire(input: FireWorkflowEventInput): Promise<WorkflowRunDetail[]> {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(input.eventName)
      || typeof input.fireId !== "string" || input.fireId.length < 1 || input.fireId.length > 128) bad("Workflow event identity is invalid.");
    const eventPayload = payload(input.payload); const runs: WorkflowRunDetail[] = [];
    for (const definition of this.enabledDefinitions()) {
      const event = definition.nodes.find((node): node is TriggerNode => node.type === "trigger"
        && node.config.kind === "event" && node.config.eventName === input.eventName);
      if (event) runs.push(await this.start(definition, event, input.fireId, eventPayload, `event:${input.fireId}`));
    }
    return runs;
  }

  async recoverTodoEvents(): Promise<number> {
    if (this.todos.size === 0) return 0;
    let count = 0;
    for (const event of this.feed.listPendingEvents(500)) count += await this.fireTodo(event);
    return count;
  }

  private enabledDefinitions(): WorkflowDefinition[] {
    const definitions: WorkflowDefinition[] = []; let cursor: string | undefined;
    do {
      const page = this.repository.listDefinitions({ enabled: true, limit: 100, ...(cursor ? { cursor } : {}) });
      definitions.push(...page.items.map((item) => this.repository.getDefinition(item.id)!).filter(Boolean));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return definitions;
  }

  private addSchedule(definition: WorkflowDefinition, schedule: TriggerNode): void {
    if (schedule.config.kind !== "schedule") return;
    const revision = definition.revision;
    const task = cron.schedule(schedule.config.cron, () => { void this.fireSchedule(definition.id, revision); },
      { timezone: schedule.config.timezone });
    this.schedules.set(definition.id, { definition, trigger: schedule, task });
  }

  private async fireSchedule(workflowId: string, revision: number): Promise<void> {
    const indexed = this.schedules.get(workflowId);
    if (!indexed || indexed.definition.revision !== revision) return;
    const fireId = this.now();
    await this.start(indexed.definition, indexed.trigger, fireId, { scheduledAt: fireId }, `schedule:${fireId}`);
  }

  private async fireTodo(event: WorkflowTodoStatusEvent): Promise<number> {
    const candidates = (this.todos.get(event.toStatus) ?? [])
      .map((item) => ({ ...item, mismatch: todoMismatch(item.trigger, event) }));
    const indexed = candidates.filter((item) => item.mismatch === undefined);
    const claim = this.feed.claimEvent(event.id, indexed.map((item) => item.definition.id));
    if (claim.state !== "acquired") return 0;
    const allowed = new Set(claim.definitionIds);
    // Record WHY a candidate did not run: a filtered-out Todo event otherwise
    // completes silently, which is indistinguishable from a broken trigger.
    const outcomes: WorkflowTodoEventClaimOutcome[] = candidates
      .filter((item) => item.mismatch !== undefined)
      .map((item) => {
        const detail = `Todo event ${event.id} suppressed: ${item.mismatch}.`;
        logger.info(`Workflow ${item.definition.id}: ${detail}`);
        return { workflowId: item.definition.id, outcome: "suppressed" as const, detail };
      });
    const labels = event.item.labels.map((label) => label.name);
    try {
      for (const item of indexed.filter((candidate) => allowed.has(candidate.definition.id))) {
        const run = await this.start(item.definition, item.trigger, event.id, {
          todoId: event.workItemId, fromStatus: event.fromStatus, toStatus: event.toStatus,
          actor: event.actor, source: event.item.source, department: event.item.department,
          assignee: event.item.assignee, labels, labelList: labels.join(", "),
        }, `todo:${event.id}`, event.workItemId);
        outcomes.push({ workflowId: item.definition.id, outcome: "started", runId: run.id, detail: `Todo event ${event.id} started.` });
      }
      this.feed.completeEvent(event.id, outcomes);
      return outcomes.filter((outcome) => outcome.outcome === "started").length;
    } catch (error) { this.feed.releaseEvent(event.id); throw error; }
  }

  private async start(definition: WorkflowDefinition, source: TriggerNode, fireId: string,
    triggerPayload: Record<string, JsonValue>, idempotencyKey: string, todoId?: string): Promise<WorkflowRunDetail> {
    const created = this.repository.createRun({ workflowId: definition.id, input: {},
      trigger: { nodeId: source.id, kind: source.config.kind, fireId, payload: triggerPayload, ...(todoId ? { todoId } : {}) },
      idempotencyKey });
    const detail = this.repository.getRun(definition.id, created.id)!;
    return detail.status === "pending" ? this.runner.start(created.id) : detail;
  }
}
