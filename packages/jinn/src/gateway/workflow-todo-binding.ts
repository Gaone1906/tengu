import type { Session } from '../shared/types.js';
import type { WorkflowService } from '../workflows/service.js';

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
