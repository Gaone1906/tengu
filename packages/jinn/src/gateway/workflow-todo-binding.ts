import type { Session } from '../shared/types.js';
import { parseTodoApprovalRef } from '../workflows/runner.js';
import type { WorkflowService } from '../workflows/service.js';
import type { WorkItem } from '../work-items/store.js';

/**
 * True when `session` is a workflow phase attempt of a run bound to `todoId`.
 *
 * The binding already exists on both sides: a `todo-status` trigger records the
 * Todo that fired it on `run.trigger.todoId`, and every phase session carries
 * its run in `workflowProvenance`. Authorization consults that pairing so a
 * pipeline can maintain the Todo it is running for — without it every phase is
 * a stranger to its own Todo and gets a 403 on the status block it is supposed
 * to keep current.
 */
export function runsWorkflowBoundToTodo(
  session: Session,
  todoId: string,
  service: WorkflowService | undefined,
): boolean {
  const provenance = session.workflowProvenance;
  if (!service || provenance?.kind !== 'phase') return false;
  return service.getRun(provenance.workflowId, provenance.runId)?.trigger.todoId === todoId;
}

/**
 * True when this Todo's pending approval mirrors a workflow gate the definition
 * declared operator-only.
 *
 * Read back through the approval `ref` rather than copied onto the approval row:
 * the workflow definition is the single source of truth for who may decide, and
 * a denormalized copy could drift from it. A Todo approval that did not come
 * from a workflow, or whose run or node has since gone, is not operator-only —
 * it keeps ordinary hierarchy routing.
 */
export function approvalIsOperatorOnly(item: WorkItem, service: WorkflowService | undefined): boolean {
  const origin = parseTodoApprovalRef(item.approvalRef);
  if (!service || !origin) return false;
  const node = service.getRun(origin.workflowId, origin.runId)?.definition.nodes
    .find((candidate) => candidate.id === origin.nodeId);
  return node?.type === 'approval' && node.config.operatorOnly === true;
}
