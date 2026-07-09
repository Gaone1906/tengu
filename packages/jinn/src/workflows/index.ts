import fs from 'node:fs';
import path from 'node:path';
import { resolveJinnHome } from '../shared/paths.js';

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

/** Default evidence root under JINN_HOME when no explicit override is set. */
export function defaultWorkflowEvidenceRoot(): string {
  return path.join(resolveJinnHome(), 'workflow-evidence');
}

/**
 * Outcome of resolving where workflow definitions and run evidence live.
 * `configured: true` means workflows are operational and `root` is a usable
 * directory. `configured: false` is a CONFIG ERROR (never a silent default):
 * `root` is null and `reason` explains what to fix.
 */
export interface WorkflowEvidenceResolution {
  root: string | null;
  configured: boolean;
  reason?: string;
}

/**
 * Resolve the workflow evidence root. Resolution order:
 *
 *  1. `JINN_WORKFLOW_EVIDENCE_ROOT` if set — an explicit override that MUST be
 *     a writable directory. Missing / not-a-dir / unwritable is a config error
 *     surfaced with a reason; we deliberately do NOT fall back to the default,
 *     because a silent fallback would hide the misconfig and split state across
 *     two roots.
 *  2. Otherwise the default `<JINN_HOME>/workflow-evidence`, created lazily
 *     (with its `workflows/` subdir) so MCP tools / CLI paths that run before or
 *     without the server boot hook still work. Only an uncreatable default
 *     (e.g. a read-only JINN_HOME) is a config error.
 */
export function resolveWorkflowEvidence(): WorkflowEvidenceResolution {
  const env = process.env.JINN_WORKFLOW_EVIDENCE_ROOT?.trim();
  if (env) {
    const root = path.resolve(env);
    let isDir = false;
    try {
      isDir = fs.statSync(root).isDirectory();
    } catch {
      return {
        root: null,
        configured: false,
        reason: `JINN_WORKFLOW_EVIDENCE_ROOT is set to "${root}" but no such directory exists.`,
      };
    }
    if (!isDir) {
      return {
        root: null,
        configured: false,
        reason: `JINN_WORKFLOW_EVIDENCE_ROOT is set to "${root}" but that path is not a directory.`,
      };
    }
    try {
      fs.accessSync(root, fs.constants.W_OK);
    } catch {
      return {
        root: null,
        configured: false,
        reason: `JINN_WORKFLOW_EVIDENCE_ROOT is set to "${root}" but that directory is not writable.`,
      };
    }
    return { root, configured: true };
  }

  const root = defaultWorkflowEvidenceRoot();
  try {
    fs.mkdirSync(path.join(root, 'workflows'), { recursive: true, mode: 0o700 });
    return { root, configured: true };
  } catch (err) {
    return {
      root: null,
      configured: false,
      reason: `Default workflow evidence root "${root}" could not be created: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The usable evidence root, or null on a config error. Thin wrapper over
 * {@link resolveWorkflowEvidence} for the many call sites that only need the
 * path; surfaces that report status to the UI use the full resolution so they
 * can include the reason.
 */
export function resolveWorkflowEvidenceRoot(): string | null {
  return resolveWorkflowEvidence().root;
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
