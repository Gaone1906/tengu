import { logger } from "../shared/logger.js";
import { deliverClaimedSessionDelivery, notifyOperatorChannel } from "../sessions/callbacks.js";
import { claimSessionDelivery, DIRECT_GROUP, isPortalAgentSession, listSessionsForGroup } from "../sessions/registry.js";
import { currentApproval } from "../work-items/approval-rows.js";
import { addComment } from "../work-items/comments.js";
import { getWorkItem, isBlockDeclared, WORKFLOW_RUN_ACTOR, type ApprovalTargetKind, type WorkItemStatus } from "../work-items/store.js";
import { transitionDerived } from "../work-items/transitions.js";
import type { WorkflowError } from "../workflows/runtime.js";
import type { WorkflowRunReflection, WorkflowTodoApprovalMirror, WorkflowTodoLifecycle } from "../workflows/runner.js";

/**
 * What a Todo-bound Workflow run owes the Todo it runs for, implemented once in
 * the platform instead of once per workflow author.
 *
 * Before this, the only reason a bound Todo moved during a run was an author
 * hand-writing `update_work_item` into every phase prompt and wiring a
 * record-failure branch into the graph. One forgotten instruction left a merged
 * Todo reading `assigned`, and a parked gate told nobody at all.
 *
 * Three obligations:
 *   - reflect the run's lifecycle onto the Todo's status
 *   - record WHY a run settled failed
 *   - tell the routed approver when the run parks on their decision
 *
 * Completion is deliberately absent. A run reaching its success End does NOT
 * close the Todo: closing is a decision, and the self-review ban means the thing
 * that did the work never makes it.
 */

/**
 * Whether a reflection is allowed to move this Todo. Sticky terminals need no
 * check — `transition` refuses to leave them without human authority — so this
 * is only about the statuses a phase can deliberately choose.
 *
 *   - `executing` is the START edge, legal only out of `backlog`/`assigned` (the
 *     same rule `transition` applies to a manual start). Anywhere else, a phase
 *     has already said something more specific and keeps it.
 *   - `in_review` yields to a DECLARED block: a phase that blocked with a real
 *     reason says more than "a decision is pending".
 *   - `blocked` always writes. A run that died is the newest and most
 *     consequential fact about the work, and leaving the board on a phase's
 *     optimistic `in_review` is the exact lie this surface exists to stop.
 */
function mayReflect(status: WorkflowRunReflection, current: WorkItemStatus, todoId: string): boolean {
  if (status === "executing") return current === "backlog" || current === "assigned";
  if (status === "in_review") return !(current === "blocked" && isBlockDeclared(todoId));
  return true;
}

function reflect(input: {
  todoId: string; status: WorkflowRunReflection; workflowId: string; runId: string; nodeId: string;
}): void {
  const item = getWorkItem(input.todoId);
  if (!item || !mayReflect(input.status, item.status, input.todoId)) return;
  // `declared: false` keeps this out of the declaration lane: the reconciler's
  // provenance checks read it, so a reflected status stays re-derivable instead of
  // freezing the Todo.
  transitionDerived(input.todoId, input.status, WORKFLOW_RUN_ACTOR, {
    declared: false,
    workflowId: input.workflowId,
    runId: input.runId,
    nodeId: input.nodeId,
  });
}

function recordFailure(input: {
  todoId: string; workflowId: string; runId: string; nodeId: string; error: WorkflowError;
}): void {
  addComment({
    workItemId: input.todoId,
    author: "workflow",
    authorKind: "system",
    body: `**Workflow run failed** — \`${input.workflowId}\` run \`${input.runId}\`.\n\n`
      + `Node \`${input.nodeId}\` (${input.error.code}): ${input.error.message}`,
  });
}

/** The gate text, trimmed to a length that reads in a notification banner. */
function gateRequest(request: string): string {
  const oneLine = request.replace(/\s+/g, " ").trim();
  return oneLine.length <= 300 ? oneLine : `${oneLine.slice(0, 300)}…`;
}

/**
 * Which session should be woken about a gate. The Todo's approval row already
 * carries the ROUTED approver, resolved when the gate was mirrored, so this only
 * has to turn that into a session:
 *
 *   - an employee → that employee's most recent live session
 *   - the virtual COO root → the portal agent session, the top-level chat the
 *     operator actually talks to. This is the common case: a gate authored
 *     without an explicit approver routes to the root, and in a gateway whose COO
 *     is deliberately not an org employee that root belongs to nobody.
 *
 * An errored session is skipped the same way a parent callback skips one.
 */
function approverSession(target: string | null, kind: ApprovalTargetKind | null | undefined) {
  const group = kind === "employee" && target ? target : DIRECT_GROUP;
  return listSessionsForGroup(group, 5, 0)
    .find((candidate) => candidate.status !== "error"
      && (group !== DIRECT_GROUP || isPortalAgentSession(candidate)));
}

/**
 * A parked gate has to reach a person. The gate is already mirrored onto the Todo
 * (so it is decidable and visible), but a mirror nobody is told about is how a
 * merge approval sat idle for eleven hours.
 *
 * Falls back to the operator's configured notification channel when there is no
 * session to wake at all. `claimSessionDelivery` is keyed on the gate's
 * correlation ref, so a re-mirror on a later recovery sweep is a no-op rather
 * than a second ping.
 */
function notifyParked(input: {
  todoId: string; workflowId: string; runId: string; nodeId: string; request: string; ref: string;
}): void {
  const approval = currentApproval(input.todoId);
  const decision = gateRequest(input.request);
  const session = approverSession(approval?.target ?? null, approval?.targetKind);

  if (!session) {
    notifyOperatorChannel(
      `⏸️ Workflow \`${input.workflowId}\` is parked on a decision for Todo ${input.todoId}.\n`
      + `Gate: ${decision}\n`
      + `Run: ${input.runId} (node \`${input.nodeId}\`)\n`
      + `Decide it on the Todo — the run resumes from your decision.`,
    );
    return;
  }

  const message =
    `⏸️ Workflow \`${input.workflowId}\` is parked waiting on YOUR decision.\n\n`
    + `Todo: ${input.todoId}\n`
    + `Run: ${input.runId} · node \`${input.nodeId}\`\n`
    + `Decision wanted: ${decision}\n\n`
    + `Decide it with decide_work_item_approval { id: "${input.todoId}", decision: "approve" | "reject" }`
    + `${approval?.options?.length ? `, choice: one of ${approval.options.map((option) => `"${option}"`).join(", ")}` : ""}. `
    + `The run stays parked until you do.`;
  const { delivery } = claimSessionDelivery({
    targetSessionId: session.id,
    sourceKind: "workflow-run",
    sourceId: input.runId,
    sourceAttempt: input.ref,
    sourceOutcome: "parked",
    sourceVersion: 1,
    deliveryKind: "workflow-approval-parked",
    payload: {
      message,
      displayMessage: `⏸️ ${input.todoId} needs a decision\n${decision}`,
    },
  });
  if (delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`Workflow run ${input.runId} could not deliver its parked-gate notice to session ${session.id}: `
      + `${error instanceof Error ? error.message : String(error)}`);
  });
}

/** The lifecycle half of the surface (status + failure record). */
export const workflowTodoLifecycle: WorkflowTodoLifecycle = { reflect, recordFailure };

/** The approval half: `request` mirrors the gate, `notifyParked` tells its approver. */
export function workflowTodoApprovals(
  request: WorkflowTodoApprovalMirror["request"],
): WorkflowTodoApprovalMirror {
  return { request, notifyParked };
}
