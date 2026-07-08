import type { CronJob } from '../shared/types.js';
import { canonicalCronJobId, loadJobs, saveJobs } from '../cron/jobs.js';
import type { EditableWorkflowDefinition } from './definition.js';
import { getDefinition, listDefinitions } from './definition-store.js';
import { startWorkflowRunFromTrigger, type RunDriverDeps } from './run-reconciler.js';
import type { WorkflowRun } from './run-store.js';
import { findRunByTriggerFireRef } from './run-store.js';

/**
 * Workflow SCHEDULE TRIGGER — definition-synced managed cron jobs + the typed fire
 * path (GRS-014d, design D6).
 *
 * Registration is a SYNC, not an imperative register/unregister pair: the pure
 * `desiredWorkflowCronJobs(definitions)` derives the managed job set from the
 * definition store, and `syncWorkflowCronJobs(existing, desired)` reconciles ONLY
 * jobs tagged `managedBy:'workflow'` — a user-authored job can never be clobbered,
 * and a manual edit of a managed job is simply re-synced away (the definition is the
 * source of truth). Deterministic identity: job id `workflow:<workflowId>`, so the
 * whole unknown-cron-job error class is gone.
 *
 * `applyWorkflowCronSync` funnels the diff through the existing cron choke point
 * (`loadJobs`/`saveJobs`; the caller reloads the scheduler via `onChanged`). It is
 * invoked from the definition CRUD routes (create/update/retire/duplicate) AND once
 * at gateway boot BEFORE the scheduler starts (drift heal — a hand-deleted or
 * hand-edited managed job is re-derived, mirroring reconcile-at-boot). jobs.json is
 * re-read IMMEDIATELY before save (design §6's named race discipline — the same
 * load→mutate→save window the cron API handlers use, acceptable single-process).
 *
 * The fire path is TYPED — no LLM in the trigger: `fireWorkflowCronJob` starts a
 * workflow run directly (`startWorkflowRun` mints the durable record before any
 * spawn), carrying `trigger:{kind:'schedule', cronJobId, fireIso}`. Idempotency is
 * file-enforced one-run-per-(workflowId, fireIso) via the run-dir scan inside
 * `startWorkflowRun` (pre-checked here only to REPORT a duplicate honestly).
 */

export const WORKFLOW_CRON_PREFIX = 'workflow:';

/** Deterministic managed-job identity for a workflow definition (design D6). */
export function workflowCronJobId(workflowId: string): string {
  return `${WORKFLOW_CRON_PREFIX}${workflowId}`;
}

/**
 * True when `until` is a parseable instant strictly before `nowIso`. An
 * UNPARSEABLE `until` is treated as no bound (the fire proceeds) — silently never
 * firing again would hide the typo forever, while firing keeps the workflow's own
 * evidence flowing; callers log the anomaly where they can.
 */
export function isPastUntil(until: string | undefined, nowIso: string): boolean {
  if (typeof until !== 'string' || !until.trim()) return false;
  const bound = Date.parse(until);
  if (Number.isNaN(bound)) return false;
  return Date.parse(nowIso) > bound;
}

/**
 * The managed cron jobs the definition store WANTS to exist (pure, design D6):
 * one enabled job per ACTIVE definition whose trigger is a schedule with a cron.
 * Paused/retired/manual-trigger definitions contribute nothing — their managed job
 * is REMOVED by the sync (re-activating the definition re-creates it). A schedule
 * whose `until` has passed keeps a DISABLED entry (the design's "the sync disables
 * the job" self-clean — visible evidence the schedule expired, not a silent vanish).
 */
export function desiredWorkflowCronJobs(
  definitions: EditableWorkflowDefinition[],
  nowIso: string,
): CronJob[] {
  const out: CronJob[] = [];
  for (const def of definitions) {
    if (!def || def.status !== 'active') continue;
    const trig = def.nodes?.find?.((n) => n?.type === 'trigger')?.trigger;
    if (!trig || trig.kind !== 'schedule') continue;
    if (typeof trig.cron !== 'string' || !trig.cron.trim()) continue;
    out.push({
      id: workflowCronJobId(def.id),
      name: def.title?.trim() || def.id,
      enabled: !isPastUntil(trig.until, nowIso),
      schedule: trig.cron.trim(),
      ...(trig.timezone ? { timezone: trig.timezone } : {}),
      managedBy: 'workflow',
      workflowId: def.id,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Field-by-field equality on the canonical managed-job shape (extras a manual edit
 * added do NOT count as equal — they get re-synced away). */
function managedJobEquals(a: CronJob, b: CronJob): boolean {
  const canon = (j: CronJob) =>
    JSON.stringify({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      schedule: j.schedule,
      timezone: j.timezone ?? null,
      managedBy: j.managedBy ?? null,
      workflowId: j.workflowId ?? null,
      // any other key present is a manual edit and must be healed
      extras: Object.keys(j).filter(
        (k) => !['id', 'name', 'enabled', 'schedule', 'timezone', 'managedBy', 'workflowId'].includes(k),
      ).sort(),
    });
  return canon(a) === canon(b);
}

export interface WorkflowCronSyncResult {
  /** The reconciled jobs array (unmanaged jobs verbatim, in place). */
  jobs: CronJob[];
  changed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  /** Desired managed ids skipped because an UNMANAGED job already holds the id —
   * the sync never clobbers a user job; the collision is reported, not resolved. */
  conflicts: string[];
}

/**
 * Reconcile the managed subset of `existing` against `desired` (pure). Jobs without
 * `managedBy:'workflow'` pass through VERBATIM in their original positions — the
 * sync owns exactly the managed set and nothing else. Managed jobs are replaced
 * wholesale when drifted (manual edits do not survive), removed when no longer
 * desired, and appended when new.
 *
 * OWNERSHIP UNDER ID COLLISIONS (Codex GRS-014d finding 2): an UNMANAGED row's id is
 * authoritative for that id, checked across ALL rows — including the duplicate-id
 * shape where jobs.json holds BOTH an unmanaged row and a managed row under one id
 * (reachable via POST /api/cron append or a hand edit). In that shape the user row is
 * untouched, the managed duplicate is REMOVED (it is sync-owned residue, and leaving
 * it would keep the scheduler double-firing one id and colliding two run histories in
 * one jsonl forever), the desired entry is NOT applied, and the id is reported ONCE
 * in `conflicts` so the applier can warn. Duplicate MANAGED rows for one id collapse
 * to a single reconciled row (first wins the desired entry; the rest are removed).
 *
 * ID IDENTITY IS CANONICAL (GRS-014d-fix2, Codex round-2): every collision/ownership
 * comparison here uses `canonicalCronJobId` (trim + lowercase) because run-log files
 * (`<id>.jsonl`) collide case-insensitively on the default macOS volume — a
 * `Workflow:wf-a` user row and a managed `workflow:wf-a` row would share one run
 * history, so they are the SAME identity for conflict purposes. Rows keep their
 * authored ids; only the comparisons canonicalize. Conflicts are reported in
 * canonical form. Two DESIRED entries colliding canonically (definitions whose ids
 * differ only by case) keep the first and report the collision as a conflict too.
 */
export function syncWorkflowCronJobs(existing: CronJob[], desired: CronJob[]): WorkflowCronSyncResult {
  const jobs: CronJob[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const conflicts = new Set<string>();

  const desiredById = new Map<string, CronJob>();
  for (const want of desired) {
    const key = canonicalCronJobId(want.id);
    if (desiredById.has(key)) {
      conflicts.add(key); // two definitions map to one canonical job id — first wins
      continue;
    }
    desiredById.set(key, want);
  }
  const unmanagedIds = new Set(
    existing.filter((j) => j && j.managedBy !== 'workflow').map((j) => canonicalCronJobId(j.id)),
  );

  for (const job of existing) {
    if (!job || job.managedBy !== 'workflow') {
      jobs.push(job); // never touch a user-authored job
      continue;
    }
    const key = canonicalCronJobId(job.id);
    if (unmanagedIds.has(key)) {
      // A user row also holds this identity — it is authoritative. Drop the managed
      // duplicate, never (re-)apply the desired entry under a user-held identity.
      conflicts.add(key);
      removed.push(job.id);
      desiredById.delete(key);
      continue;
    }
    const want = desiredById.get(key);
    if (!want) {
      removed.push(job.id); // dropped (or a duplicate managed identity — first one consumed the want)
      continue;
    }
    desiredById.delete(key);
    if (managedJobEquals(job, want)) {
      jobs.push(job);
    } else {
      jobs.push(want);
      updated.push(job.id);
    }
  }
  for (const [key, want] of desiredById) {
    if (unmanagedIds.has(key)) {
      conflicts.add(key);
      continue;
    }
    jobs.push(want);
    added.push(want.id);
  }
  return {
    jobs,
    changed: added.length + updated.length + removed.length > 0,
    added,
    updated,
    removed,
    conflicts: [...conflicts],
  };
}

export interface ApplyWorkflowCronSyncOptions {
  now?: () => string;
  /** Called with the reconciled jobs after a save — the caller reloads the scheduler
   * here (kept injected so this module never reaches into scheduler state). */
  onChanged?: (jobs: CronJob[]) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * Derive the desired managed set from the definitions on `root` and reconcile
 * jobs.json (impure applier over the pure halves above). jobs.json is loaded
 * immediately before the diff+save — no await sits between load and save, so the
 * window is closed in-process. No definitions and no managed jobs → no write at all.
 */
export function applyWorkflowCronSync(
  root: string,
  opts: ApplyWorkflowCronSyncOptions = {},
): WorkflowCronSyncResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const definitions = listDefinitions(root)
    .map((summary) => {
      try {
        return getDefinition(root, summary.id);
      } catch {
        return null; // a corrupt definition contributes no managed job; never fatal
      }
    })
    .filter((def): def is EditableWorkflowDefinition => def !== null);
  const desired = desiredWorkflowCronJobs(definitions, now());
  const existing = loadJobs(); // re-read immediately before save (design §6)
  const result = syncWorkflowCronJobs(existing, desired);
  if (result.changed) {
    saveJobs(result.jobs);
    opts.onChanged?.(result.jobs);
  }
  for (const id of result.conflicts) {
    opts.log?.('warn', `[workflow-cron] desired managed job "${id}" collides with a user-authored cron job — left untouched; rename one side`);
  }
  if (result.changed) {
    opts.log?.(
      'info',
      `[workflow-cron] synced managed cron jobs: +${result.added.length} ~${result.updated.length} -${result.removed.length}`,
    );
  }
  return result;
}

/* ── The typed fire path ────────────────────────────────────────────────────── */

export type WorkflowCronFireOutcome =
  | { outcome: 'started'; run: WorkflowRun; detail: string }
  | { outcome: 'duplicate'; runId: string; detail: string }
  | { outcome: 'expired'; detail: string }
  | { outcome: 'stale'; detail: string };

/**
 * Fire a managed workflow cron job (GRS-014d): start a run of its workflow with
 * `trigger:{kind:'schedule', cronJobId, fireIso}` — directly, no prompt session, no
 * LLM. Honest no-ops:
 *   - `duplicate` — a run already claims (workflowId, fireIso); nothing started.
 *   - `expired`  — the fire is past the definition trigger's `until`; the caller
 *     should re-run the sync, which disables the job (self-cleaning).
 *   - `stale`    — the job no longer maps to an active schedule-trigger definition
 *     (missing/paused/retired/manual); the caller's re-sync removes it.
 */
export async function fireWorkflowCronJob(
  deps: RunDriverDeps,
  job: CronJob,
  fireIso: string,
): Promise<WorkflowCronFireOutcome> {
  const workflowId = job.workflowId;
  if (!workflowId) {
    return { outcome: 'stale', detail: `managed cron job "${job.id}" carries no workflowId` };
  }
  const def = deps.getDefinition(deps.root, workflowId);
  if (!def) {
    return { outcome: 'stale', detail: `workflow definition "${workflowId}" no longer exists` };
  }
  const trig = def.nodes?.find?.((n) => n?.type === 'trigger')?.trigger;
  if (def.status !== 'active' || !trig || trig.kind !== 'schedule') {
    return {
      outcome: 'stale',
      detail: `workflow "${workflowId}" is ${def.status !== 'active' ? def.status : 'not schedule-triggered'} — managed job is stale`,
    };
  }
  if (isPastUntil(trig.until, fireIso)) {
    return { outcome: 'expired', detail: `fire ${fireIso} is past the schedule's until (${trig.until})` };
  }
  // Report-only pre-check; the authoritative file-enforced guard is inside
  // startWorkflowRun (scan + first save are synchronous there).
  const existing = findRunByTriggerFireRef(deps.root, workflowId, 'schedule', 'schedule.fire', fireIso);
  if (existing) {
    return {
      outcome: 'duplicate',
      runId: existing.runId,
      detail: `fire ${fireIso} already ran as ${existing.runId}`,
    };
  }
  const run = await startWorkflowRunFromTrigger(deps, def, {
    source: 'schedule',
    event: 'schedule.fire',
    payload: { cronJobId: job.id, fireIso },
    fireRef: fireIso,
  });
  return {
    outcome: 'started',
    run,
    detail: `workflow run ${run.runId} started (status: ${run.status})`,
  };
}
