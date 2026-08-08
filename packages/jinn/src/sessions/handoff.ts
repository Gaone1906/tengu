import fs from "node:fs";
import path from "node:path";
import type { CronJob, Engine, Session } from "../shared/types.js";
import { HANDOFFS_DIR, JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { GovernorDecision } from "../shared/governor.js";
import { getWorkItem } from "../work-items/store.js";
import { addComment } from "../work-items/comments.js";
import { upsertJob, loadJobs } from "../cron/jobs.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { validateCronSchedule } from "../cron/validation.js";
import { commitWipRef, hasWipRef } from "../security/wip-rescue.js";

/**
 * Halt/handoff/auto-resume (docs/tengu/03-implementation-plan.md step 6,
 * docs/tengu/10-checkpointing.md). Triggered from gateway/api.ts's governor
 * enforcement seam when evaluateGovernor() returns a "halt" decision with a
 * resumeAt — i.e. a 5-hour/7-day usage stop, not the context-only "handoff"
 * action (D5: that one compacts in place and never halts).
 *
 * Because checkpointing (work-items/{store,reconcile,checkpoint}.ts) already
 * makes the ledger the record of what was COMPLETED, this file is deliberately
 * small: it carries only in-flight state the ledger cannot express.
 */

export interface HandoffNote {
  employee: string;
  todoId: string;
  sessionId: string;
  interruptedUnit: string;
  attempted: string;
  wipRef?: string;
  surprises?: string;
}

function handoffFilename(employee: string, todoId: string): string {
  const safeEmployee = employee.trim() || "unassigned";
  const safeTodoId = todoId.trim() || "unlinked";
  return `${safeEmployee}-${safeTodoId}.md`;
}

export function handoffPathFor(employee: string, todoId: string): string {
  return path.join(HANDOFFS_DIR, handoffFilename(employee, todoId));
}

/** Writes ONLY in-flight state: the interrupted unit, what was tried, the WIP
 *  ref, and anything surprising. The ledger already records what was actually
 *  completed, so nothing here duplicates it. */
export function writeHandoffFile(note: HandoffNote): string {
  fs.mkdirSync(HANDOFFS_DIR, { recursive: true });
  const filePath = handoffPathFor(note.employee, note.todoId);
  const lines = [
    `# Handoff — ${note.employee} — ${note.todoId}`,
    "",
    `Session: ${note.sessionId}`,
    `Written: ${new Date().toISOString()}`,
    "",
    "## Interrupted unit",
    "",
    note.interruptedUnit,
    "",
    "## What was tried",
    "",
    note.attempted,
  ];
  if (note.wipRef) lines.push("", "## WIP ref", "", note.wipRef);
  if (note.surprises) lines.push("", "## Surprises", "", note.surprises);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  logger.info(`Handoff written for ${note.employee}/${note.todoId} at ${filePath}`);
  return filePath;
}

/** Records the handoff's path on the work item via the existing comment
 *  layer (work-items/comments.ts) — queryable, audited, no schema change.
 *  Best-effort: a comment failure must never block the halt itself. */
export function recordHandoffOnWorkItem(todoId: string, handoffPath: string): void {
  try {
    addComment({
      workItemId: todoId,
      body: `Governor halt — handoff written: \`${handoffPath}\``,
      author: "governor",
      authorKind: "system",
    });
  } catch (err) {
    logger.warn(`Failed to record handoff comment on ${todoId}: ${err instanceof Error ? err.message : err}`);
  }
}

export interface ScheduleResumeOptions {
  session: Session;
  employee: string;
  todoId: string;
  /** ISO timestamp of the window reset the governor reported (e.g. five_hour.resets_at). */
  resumeAt: string;
  /** Buffer past the reset before firing. Default 60s (step 6). */
  bufferMs?: number;
}

/**
 * Persists (and hot-loads, in a live gateway) a one-shot "runAt" cron job that
 * resumes THIS session — by sessionKey, via gateway/api.ts's
 * resumeGovernorHaltedSession, wired into the scheduler by gateway/server.ts —
 * rather than minting a fresh one (D4). Fires at `resumeAt + bufferMs`.
 */
export function scheduleGovernorResume(opts: ScheduleResumeOptions): CronJob {
  const bufferMs = opts.bufferMs ?? 60_000;
  const resumeAtMs = new Date(opts.resumeAt).getTime();
  if (!Number.isFinite(resumeAtMs)) {
    throw new Error(`scheduleGovernorResume: resumeAt "${opts.resumeAt}" is not a valid timestamp`);
  }
  const runAt = new Date(resumeAtMs + bufferMs).toISOString();
  const job: CronJob = {
    id: `governor-resume-${opts.session.id}`,
    name: `Governor resume — ${opts.employee} — ${opts.todoId}`,
    enabled: true,
    kind: "runAt",
    schedule: "",
    runAt,
    resumeSessionKey: opts.session.sessionKey,
    employee: opts.employee,
    prompt: "Resume the interrupted unit. Read the ledger and the handoff note before continuing — do not redo completed work.",
  };
  const validation = validateCronSchedule({ schedule: job.schedule, kind: "runAt", runAt: job.runAt });
  if (validation.length > 0) {
    throw new Error(`invalid governor resume job: ${validation.map((entry) => entry.message).join("; ")}`);
  }
  upsertJob(job);
  try {
    // Best-effort: activates the job immediately in a live gateway. A CLI-only
    // or test context with no running scheduler just persists it for next boot.
    reloadScheduler(loadJobs());
  } catch (err) {
    logger.warn(`Governor resume job ${job.id} persisted but could not be hot-loaded: ${err instanceof Error ? err.message : err}`);
  }
  logger.info(`Scheduled governor resume for session ${opts.session.id} (${opts.employee}/${opts.todoId}) at ${runAt}`);
  return job;
}

export interface GovernorHaltOptions {
  session: Session;
  employee: string;
  engine: Engine;
  engineBin?: string;
  engineModel?: string;
  decision: GovernorDecision;
  /** Working tree to rescue on-disk edits from. Absent for sessions with no
   *  associated repo checkout — WIP rescue is then simply skipped. */
  cwd?: string;
}

export interface GovernorHaltResult {
  handoffPath: string;
  job: CronJob;
}

/**
 * Orchestrates the halt: write the handoff, record it on the work item,
 * best-effort compact the session in place, then schedule the resume. Does
 * NOT touch session status — the caller (gateway/api.ts) owns that
 * transition via completeSessionAttempt, same as every other terminal
 * outcome at that call site.
 */
export async function performGovernorHalt(opts: GovernorHaltOptions): Promise<GovernorHaltResult> {
  const { session, employee, engine, decision } = opts;
  if (!decision.resumeAt) {
    throw new Error("performGovernorHalt requires a governor decision with resumeAt");
  }

  const todoId = session.workItemId ?? session.id;
  const workItem = session.workItemId ? getWorkItem(session.workItemId) : undefined;

  let wipRef: string | undefined;
  if (opts.cwd) {
    try {
      commitWipRef(opts.cwd, session.id);
      if (hasWipRef(opts.cwd, session.id)) wipRef = `refs/jinn/wip/${session.id}`;
    } catch (err) {
      logger.warn(`WIP rescue failed for session ${session.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const handoffPath = writeHandoffFile({
    employee,
    todoId,
    sessionId: session.id,
    interruptedUnit: workItem?.title ?? session.title ?? "(no linked work item)",
    attempted: session.lastError ?? "Halted by the usage governor before this unit could be attempted further this window.",
    ...(wipRef ? { wipRef } : {}),
  });

  if (session.workItemId) recordHandoffOnWorkItem(session.workItemId, handoffPath);

  if (session.engineSessionId) {
    try {
      await engine.run({
        prompt: "/compact",
        resumeSessionId: session.engineSessionId,
        cwd: JINN_HOME,
        bin: opts.engineBin,
        model: opts.engineModel ?? session.model ?? undefined,
        sessionId: session.id,
      });
    } catch (err) {
      logger.warn(`Pre-halt /compact failed for session ${session.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const job = scheduleGovernorResume({ session, employee, todoId, resumeAt: decision.resumeAt });

  return { handoffPath, job };
}
