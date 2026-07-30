import { parseTodoApprovalRef } from '../workflows/todo-approval-ref.js';
import type { WorkflowService } from '../workflows/service.js';
import type { WorkItem } from '../work-items/store.js';

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
