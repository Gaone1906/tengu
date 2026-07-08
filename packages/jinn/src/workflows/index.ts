import fs from 'node:fs';
import path from 'node:path';

export * from './derive.js';
export * from './definition.js';
export * from './definition-store.js';
export * from './execution-plan.js';
export * from './order.js';
export * from './handoff.js';
export * from './run-store.js';
export * from './advance.js';
export * from './run-reconciler.js';
export * from './cron-sync.js';
export * from './todo-status-trigger.js';
export * from './custom-triggers.js';
export * from './poll-trigger.js';
export * from './authoring.js';

/**
 * Where workflow definitions and run evidence live. This is deliberately
 * decoupled from JINN_HOME and disabled by default: the gateway reads only an
 * explicit JINN_WORKFLOW_EVIDENCE_ROOT. When unset or invalid, workflow routes
 * return their normal unavailable/not-found responses instead of discovering a
 * local test/sprint directory by accident.
 */
export function resolveWorkflowEvidenceRoot(): string | null {
  const env = process.env.JINN_WORKFLOW_EVIDENCE_ROOT?.trim();
  if (!env) return null;
  const root = path.resolve(env);
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** List workflow ids by scanning `<evidenceRoot>/workflows/*.workflow.yaml`. */
export function listWorkflowIds(evidenceRoot: string): string[] {
  const dir = path.join(evidenceRoot, 'workflows');
  try {
    return fs.readdirSync(dir)
      .map((n) => /^(.+)\.workflow\.yaml$/.exec(n)?.[1])
      .filter((v): v is string => typeof v === 'string')
      .sort();
  } catch {
    return [];
  }
}
