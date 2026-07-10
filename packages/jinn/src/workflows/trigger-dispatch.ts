import type { EditableWorkflowDefinition } from './definition.js';
import type { RunDriverDeps } from './run-reconciler.js';

export type ActiveTriggerDefinitionResult =
  | { state: 'active'; definition: EditableWorkflowDefinition }
  | { state: 'missing' }
  | { state: 'inactive' };

/** One status gate shared by every custom-trigger dispatcher. */
export function resolveActiveTriggerDefinition(
  deps: Pick<RunDriverDeps, 'root' | 'getDefinition'>,
  workflowId: string,
): ActiveTriggerDefinitionResult {
  const definition = deps.getDefinition(deps.root, workflowId);
  if (!definition) return { state: 'missing' };
  if (definition.status !== 'active') return { state: 'inactive' };
  return { state: 'active', definition };
}
