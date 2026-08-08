import { execFileSync } from 'node:child_process';
import { evaluateCommandPolicy } from '../shared/command-policy.js';
import { logger } from '../shared/logger.js';
import { appendWorkItemEvent, getWorkItem, type WorkItem } from './store.js';
import { upsertVerifyCommand } from './verify-rows.js';
import { transition, type TransitionResult } from './transitions.js';

/**
 * Checkpointing (docs/tengu/10-checkpointing.md, D12) — the sub-sub-task
 * (depth 3) execution model: run `verify` first (idempotency — a re-run that's
 * already done costs zero model tokens), do the work, commit it, THEN mark the
 * ledger done. Never the reverse: a git commit with no ledger write is safely
 * redoable (reconcile finds it via a passing `verify`); a ledger write with no
 * commit is not — the work it claims does not durably exist.
 *
 * `verify` is model-generated shell, so every execution routes through
 * `evaluateCommandPolicy` — the same gate `PreToolUse` Bash calls go through
 * (`gateway/hook-endpoint.ts`), not a second, weaker one.
 */

export type VerifyOutcome = 'passed' | 'failed' | 'blocked';

export interface VerifyRunResult {
  outcome: VerifyOutcome;
  /** The policy's refusal reason, set only when outcome is 'blocked'. */
  blockedReason?: string;
  /** Combined stdout+stderr, truncated to keep audit details small. */
  output: string;
  exitCode: number | null;
}

const MAX_VERIFY_OUTPUT_CHARS = 4_000;
const VERIFY_TIMEOUT_MS = 120_000;

function truncate(text: string): string {
  return text.length > MAX_VERIFY_OUTPUT_CHARS ? `${text.slice(0, MAX_VERIFY_OUTPUT_CHARS)}\n… (truncated)` : text;
}

/**
 * Run a `verify` command under the security policy gate. A blocked command
 * counts as a failure (`outcome: 'blocked'`) — it never runs, and the unit it
 * belongs to stays not-done rather than either silently passing or throwing.
 */
export function runVerifyCommand(command: string, cwd: string): VerifyRunResult {
  const decision = evaluateCommandPolicy(command, cwd);
  if (decision.action === 'block') {
    logger.warn(`work-items/checkpoint: verify command blocked by policy in ${cwd}: ${decision.reason ?? 'refused'}`);
    return { outcome: 'blocked', blockedReason: decision.reason, output: '', exitCode: null };
  }
  try {
    const output = execFileSync('bash', ['-lc', command], {
      cwd,
      encoding: 'utf-8',
      timeout: VERIFY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { outcome: 'passed', output: truncate(output), exitCode: 0 };
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer; signal?: string | null };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    return { outcome: 'failed', output: truncate(output), exitCode: failure.status ?? null };
  }
}

/** Run the item's own `verify` command (undefined outcome for an item with none). */
export function runVerifyForWorkItem(item: Pick<WorkItem, 'id' | 'verifyCommand'>, cwd: string): VerifyRunResult | undefined {
  if (!item.verifyCommand) return undefined;
  return runVerifyCommand(item.verifyCommand, cwd);
}

/**
 * Set (insert or replace) a depth-3 sub-sub-task's `verify` command, auditing
 * the change. Throws if the item is unknown or is not at depth 3 — the same
 * invariant `createWorkItem` enforces at creation, re-checked here for the
 * update path so it holds regardless of which write reaches it first.
 */
export function setVerifyCommand(workItemId: string, command: string, actor: string): string {
  const item = getWorkItem(workItemId);
  if (!item) throw new Error(`work item ${workItemId} not found`);
  if (item.depth !== 3) {
    throw new Error(`verify can only be set on a depth-3 sub-sub-task (${item.id} is at depth ${item.depth})`);
  }
  const stored = upsertVerifyCommand(item.id, command);
  appendWorkItemEvent({
    workItemId: item.id,
    kind: 'metadata_edited',
    actor,
    detail: { verifyCommand: stored.command },
    versionEffect: 'companion',
  });
  return stored.command;
}

function gitCommit(cwd: string, message: string, opts?: { allowEmpty?: boolean }): string {
  const args = ['commit', '-m', message];
  if (opts?.allowEmpty) args.push('--allow-empty');
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5_000 }).trim();
}

export class CheckpointError extends Error {
  readonly code: 'commit-failed' | 'verify-failed' | 'verify-blocked';
  readonly commitSha?: string;

  constructor(code: CheckpointError['code'], message: string, commitSha?: string) {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
    this.commitSha = commitSha;
  }
}

export interface LandCheckpointOptions {
  /** The employee's workspace — where the staged work lives and `verify` runs. */
  cwd: string;
  actor: string;
  /** Human-readable summary; the commit message becomes `<id>: <summary>`. */
  summary: string;
  /** Commit with nothing staged (docs-only / already-committed units). */
  allowEmpty?: boolean;
}

export interface LandCheckpointResult {
  item: WorkItem;
  commitSha: string;
  verify?: VerifyRunResult;
}

/**
 * The checkpoint pair, in the mandated order: commit the staged work FIRST
 * (`<id>: <summary>`), THEN — only if `verify` (when the item has one) passes
 * — transition the ledger to `done`. A commit followed by a failing `verify`
 * throws `CheckpointError`: the work IS durable (the commit landed), so this is
 * safe to leave not-done and retry — never the unrecoverable status-without-
 * commit ordering.
 */
export function landCheckpoint(workItemId: string, opts: LandCheckpointOptions): LandCheckpointResult {
  const item = getWorkItem(workItemId);
  if (!item) throw new Error(`work item ${workItemId} not found`);
  const message = `${item.id}: ${opts.summary}`;
  let commitSha: string;
  try {
    commitSha = gitCommit(opts.cwd, message, { allowEmpty: opts.allowEmpty });
  } catch (err) {
    throw new CheckpointError('commit-failed', `git commit failed for ${item.id} in ${opts.cwd}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let verify: VerifyRunResult | undefined;
  if (item.verifyCommand) {
    verify = runVerifyCommand(item.verifyCommand, opts.cwd);
    if (verify.outcome === 'blocked') {
      throw new CheckpointError('verify-blocked', `verify for ${item.id} was blocked by policy: ${verify.blockedReason ?? 'refused'}`, commitSha);
    }
    if (verify.outcome !== 'passed') {
      throw new CheckpointError('verify-failed', `verify failed for ${item.id} after commit ${commitSha}: ${verify.output}`, commitSha);
    }
  }
  const result: TransitionResult = transition(item.id, 'done', opts.actor, {
    detail: { commitSha, verified: !!verify },
  });
  return { item: result.item, commitSha, verify };
}
