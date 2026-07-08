import type { CronJob, Connector, JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { appendRunLog, hasRunLogEntry } from "./jobs.js";
import { scanOrg, findEmployee } from "../gateway/org.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { createWorkItem, linkSession, type WorkItem } from "../work-items/store.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import { getSessionBySessionKey } from "../sessions/registry.js";

/**
 * GRS-003b-2b — best-effort repair of the cron→work-item bridge for an already-spawned
 * fire, WITHOUT re-running the prompt. Called from the execution-idempotency guard: if a
 * prior fire spawned the session but its link/reconcile (or even its mint) failed under
 * best-effort semantics, the run-log still recorded a terminal outcome, so the guard would
 * otherwise short-circuit and leave the item stuck `open` with zero linked sessions —
 * unrepairable by startup reconcile (which derives only from linked sessions). Re-deriving
 * the bridge here idempotently self-heals the linkage on any same-`fireIso` re-invocation
 * (the retrying dispatcher, GRS-003b-2c). Every step is idempotent: `createWorkItem` returns
 * the existing row for this `sourceRef`, `linkSession` re-stamps the same `work_item_id`, and
 * `reconcileWorkItem` re-derives status. No-op when the session isn't found (nothing spawned
 * yet) or anything throws.
 */
function repairCronWorkItemBridge(job: CronJob, sessionKey: string): void {
  try {
    const session = getSessionBySessionKey(sessionKey);
    if (!session) return;
    const workItem = createWorkItem({
      title: job.name,
      body: job.prompt,
      status: "backlog",
      source: "cron",
      sourceRef: sessionKey,
    });
    linkSession(workItem.id, session.id);
    reconcileWorkItem(workItem.id);
  } catch (err) {
    logger.warn(
      `Cron job "${job.name}" work-item bridge repair skipped: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Fires a MANAGED workflow cron job (GRS-014d): starts a typed workflow run for
 * `job.workflowId` with this fire's identity — no prompt session, no LLM in the
 * trigger path. Injected by the gateway (the handler closes over the ApiContext the
 * step spawner needs); the runner stays free of workflow imports. `ok:false` means
 * the fire did NOT start or no-op cleanly (recorded as an error run-log row).
 */
export type WorkflowCronFire = (
  job: CronJob,
  fireIso: string,
) => Promise<{ ok: boolean; note: string; runId?: string }>;

export interface RunCronJobOptions {
  /**
   * Deterministic identity of *this logical fire*, owned by the caller (the
   * scheduler captures it once at fire time). Drives `sessionKey`/`sourceRef` as
   * `cron:<jobId>:<fireIso>`. Passing it makes `runCronJob` an idempotent operation
   * for that fire on TWO levels:
   *  - execution (GRS-003b-2a): a re-invocation whose prior run already recorded a
   *    terminal run-log outcome short-circuits BEFORE `route()` — the prompt is not
   *    re-run and no duplicate run-log row is appended (see the guard below);
   *  - durable records (GRS-003b-1): if it does proceed, `route()` reuses the session
   *    *row* by sessionKey and the work-item bridge returns the existing item + re-stamps
   *    the same link, so no second session/work-item is created.
   *
   * STILL DEFERRED (GRS-003b-2c dispatcher): the concurrent in-flight window — a second
   * fire arriving before the first appends its terminal run-log row — is not closed by
   * the completed-ledger guard; that needs a pre-execution lock/started-marker.
   *
   * Defaults to a fresh `new Date().toISOString()` when absent, preserving legacy
   * per-call uniqueness for ad-hoc callers (manual `/cron run`, HTTP run-now), which
   * are therefore never deduped — every ad-hoc call is a new fire by definition.
   */
  fireIso?: string;
  /**
   * GRS-014d — the managed-workflow fire handler. Absent (an unwired boot, tests, or
   * a production-shaped home whose gateway has no workflow evidence root) → a managed
   * job's fire is INERT: a logged warning + an honest error run-log row, no session,
   * no crash. Unmanaged jobs never consult it.
   */
  workflowFire?: WorkflowCronFire;
}

/**
 * The managed-job fire wrapper (GRS-014d): delegate to the injected handler and
 * record ONE honest terminal run-log row for the fire — `success` rows carry the
 * handler's note (run started / duplicate no-op / expired no-op) in resultPreview so
 * the cron UI's run history stays meaningful for managed jobs; failures (no handler
 * wired, stale job, handler crash) are `error` rows. The row also arms the
 * `hasRunLogEntry` fast-guard for a re-invocation of the same fireIso (the run-dir
 * scan inside the workflow store stays the authoritative dedupe).
 */
async function runManagedWorkflowFire(
  job: CronJob,
  fireIso: string,
  sessionKey: string,
  startedAt: string,
  startTime: number,
  fire: WorkflowCronFire | undefined,
): Promise<void> {
  const logRow = (status: "success" | "error", note: string, runId?: string): void => {
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      sessionId: null,
      ...(runId ? { workflowRunId: runId } : {}),
      status,
      durationMs: Date.now() - startTime,
      error: status === "error" ? note : null,
      resultPreview: status === "success" ? note : null,
    });
  };
  if (!fire) {
    const msg =
      "managed workflow job fired but no workflow fire handler is wired " +
      "(no workflow evidence root on this gateway?) — fire skipped";
    logger.warn(`Cron job "${job.name}" (${job.id}): ${msg}`);
    logRow("error", msg);
    return;
  }
  try {
    const result = await fire(job, fireIso);
    logRow(result.ok ? "success" : "error", result.note, result.runId);
    logger[result.ok ? "info" : "warn"](
      `Cron job "${job.name}" (${job.id}) workflow fire: ${result.note}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logRow("error", message);
    logger.error(`Cron job "${job.name}" (${job.id}) workflow fire crashed: ${message}`);
  }
}

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
  opts?: RunCronJobOptions,
): Promise<void> {
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const cooSlug = config.portal?.portalName?.toLowerCase() || "jinn";
  if (delivery && job.employee && job.employee !== cooSlug) {
    logger.debug(
      `Cron job "${job.name}" targets employee "${job.employee}" directly (skipping COO delegation).`,
    );
  }

  const connector = new CronConnector(connectors, delivery);
  const startedAt = new Date().toISOString();
  // Deterministic per-fire identity (GRS-003b-1). Caller-owned `fireIso` makes a
  // re-invocation of the same logical fire idempotent; the default keeps legacy
  // per-call uniqueness for ad-hoc callers that don't pass one.
  const fireIso = opts?.fireIso ?? new Date().toISOString();
  const sessionKey = `cron:${job.id}:${fireIso}`;

  // GRS-003b-2a — execution idempotency (single-shot per fire). When the caller owns
  // the fire identity (deterministic `fireIso`), a re-invocation of the SAME fire must
  // execute the prompt at most once and append at most one run-log row. The completed
  // run-log is the durable single-shot ledger: if this exact fire already recorded an
  // outcome, short-circuit BEFORE route() (no prompt re-run), before minting, and
  // before appending a second run-log row. This makes `runCronJob(..., {fireIso})` an
  // idempotent operation the future retrying/at-least-once dispatcher (GRS-003b-2c) can
  // lean on. Ad-hoc callers pass no `fireIso` → a fresh per-call ISO that never
  // collides, so every ad-hoc call is a new fire by definition and is never deduped.
  //
  // KNOWN GAP (deferred to GRS-003b-2c dispatcher): this guards a re-fire that arrives
  // AFTER the prior run settled and wrote its outcome. A concurrent in-flight
  // double-fire (a second fire arriving before the first appends its run-log) is NOT
  // covered — closing that needs a pre-execution lock/started-marker, not a
  // completed-ledger read.
  if (opts?.fireIso && hasRunLogEntry(job.id, sessionKey)) {
    logger.info(
      `Cron job "${job.name}" (${job.id}) fire ${fireIso} already executed — skipping duplicate run.`,
    );
    // The prompt is not re-run, but still self-heal the durable bridge: a prior fire
    // may have spawned the session yet failed its best-effort link/reconcile/mint,
    // which startup reconcile can't repair. This is idempotent and a no-op on the
    // happy path (item already linked → reconcile derives the same status).
    // Managed workflow jobs have no session/work-item bridge — nothing to repair.
    if (job.managedBy !== "workflow") repairCronWorkItemBridge(job, sessionKey);
    return;
  }

  // GRS-014d — MANAGED WORKFLOW JOBS fire a typed workflow run, never a prompt
  // session: no work-item mint, no org scan, no route(), no LLM in the trigger path.
  // The injected handler owns the run start (fireIso-idempotent inside the run
  // store); this branch owns the honest cron run-log row either way.
  if (job.managedBy === "workflow") {
    await runManagedWorkflowFire(job, fireIso, sessionKey, startedAt, startTime, opts?.workflowFire);
    return;
  }

  // GRS-003b-2b — atomic-ordered cron-bridge (mint-before-spawn). The session spawn
  // (`route()` below) is the only non-DB, non-rollbackable step, so the durable work
  // item — the record of INTENT — is minted BEFORE it. When the mint SUCCEEDS, a crash
  // around the spawn never loses intent: the worst case is a recoverable `backlog` item with
  // zero linked sessions, never a stuck `executing` item the reconciler can't derive back.
  // (If the mint itself fails — best-effort — `route()` can still spawn a session with no
  // item; that residual orphan is healed only by a same-`fireIso` re-invocation via the
  // guard-time `repairCronWorkItemBridge` above, i.e. the future retrying dispatcher
  // GRS-003b-2c. node-cron does not redeliver a tick, so there is no live auto-heal yet.)
  //
  // Status is `backlog` at mint (NOT `executing`): with zero linked sessions there is no
  // evidence to derive from, and `open` is exactly what the GRS-003a reconciler leaves
  // untouched (its zero-session rule) AND what a future dispatcher (GRS-003b-2c) looks
  // for to (re)spawn. The LIVE status is DERIVED by `reconcileWorkItem` after the session
  // is linked (below) — status is never hardcoded here, which kills the split-brain seed
  // (the old bridge stamped a live status at mint, drifting from real session state).
  //
  // Best-effort: a work-item failure must never break the actual cron job (the item is a
  // dogfood consumer, not load-bearing). `sessionKey` (`cron:<jobId>:<fireIso>`) is this
  // fire's deterministic source_ref, so a re-fire idempotently returns the SAME item
  // (partial UNIQUE on `(source, source_ref)`), reuses the session row, and re-links.
  //
  // Rejected alternative (criterion 2): mint-after-spawn + a rollback-safe mint+link
  // transaction. Because the spawn is irreversible and would run first, a crash before
  // the txn leaves an orphaned session with NO durable intent — strictly worse.
  let workItem: WorkItem | undefined;
  try {
    workItem = createWorkItem({
      title: job.name,
      body: job.prompt,
      status: "backlog",
      source: "cron",
      sourceRef: sessionKey,
    });
  } catch (wiErr) {
    logger.warn(
      `Cron job "${job.name}" work-item mint skipped: ${wiErr instanceof Error ? wiErr.message : wiErr}`,
    );
  }

  try {
    // Org scanning lives inside the try: org/ hot-reloads, and a malformed YAML
    // mid-edit must surface as a logged job failure, not an unhandled rejection.
    let employee;
    if (job.employee) {
      const orgRegistry = scanOrg();
      employee = findEmployee(job.employee, orgRegistry);
    }

    const routeResult = await sessionManager.route(
      {
        connector: connector.name,
        source: "cron",
        sessionKey,
        replyContext: {
          channel: delivery?.channel || job.id,
          messageTs: null,
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
        },
        messageId: undefined,
        channel: delivery?.channel || job.id,
        thread: undefined,
        user: "system",
        userId: "system",
        text: job.prompt ?? "",
        attachments: [],
        raw: { jobId: job.id, trigger: "cron" },
        transportMeta: {
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
          deliveryChannel: delivery?.channel ?? null,
        },
      },
      connector,
      {
        employee,
        engine: job.engine || employee?.engine || config.engines.default,
        model: job.model || employee?.model || config.engines[(job.engine || config.engines.default) as "claude" | "codex" | "antigravity"]?.model,
        // A cron job's configured effort is a per-fire override; pass it as the
        // session-level effortLevel only. Do NOT merge it onto the employee,
        // otherwise an invalid job.effortLevel would clobber the employee's valid
        // default and defeat resolveEffort()'s graceful skip→employee fallback.
        effortLevel: job.effortLevel,
        title: job.name,
      },
    );

    // GRS-003b-2b — the irreversible spawn succeeded; now link the session to the
    // pre-minted work item and DERIVE its live status. `linkSession` is transactional
    // (rolls back if either row is missing) and idempotent (re-stamps the same
    // `work_item_id` on a re-fire). `reconcileWorkItem` then moves the item `backlog`→`executing`
    // from the now-linked session's real state — the reconciler (GRS-003a) is the single
    // source of truth for status, so the bridge never hardcodes it. Best-effort: a
    // link/reconcile failure must never break the actual cron job. If the process instead
    // crashed between spawn and here, the work item stays a recoverable `backlog` (reconciler
    // leaves zero-session items untouched) and a re-fire relinks it.
    if (workItem && routeResult?.sessionId) {
      try {
        linkSession(workItem.id, routeResult.sessionId);
        reconcileWorkItem(workItem.id);
      } catch (linkErr) {
        logger.warn(
          `Cron job "${job.name}" work-item link skipped: ${linkErr instanceof Error ? linkErr.message : linkErr}`,
        );
      }
    }

    const durationMs = Date.now() - startTime;
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      sessionId: routeResult?.sessionId ?? null,
      status: "success",
      durationMs,
      error: null,
      resultPreview: null,
    });
    logger.info(`Cron job "${job.name}" completed in ${durationMs}ms`);

    // Latency alert: warn if job exceeded threshold
    const thresholdMs = config.cron?.alertThresholdMs;
    if (thresholdMs && durationMs > thresholdMs) {
      const alertConnector = config.cron?.alertConnector;
      const alertChannel = config.cron?.alertChannel;
      if (alertConnector && alertChannel) {
        const alertTarget = connectors.get(alertConnector);
        if (alertTarget) {
          const mins = (durationMs / 60_000).toFixed(1);
          const threshMins = (thresholdMs / 60_000).toFixed(1);
          await alertTarget.sendMessage(
            { channel: alertChannel },
            `🐢 Cron latency alert: "${job.name}" (${job.id}) exceeded threshold — took ${mins}min (threshold: ${threshMins}min). Session: ${routeResult?.sessionId ?? "unknown"}`,
          ).catch((alertErr) => {
            logger.error(`Failed to send latency alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
          });
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "error",
      durationMs: Date.now() - startTime,
      error: message,
      resultPreview: null,
    });
    logger.error(`Cron job "${job.name}" failed: ${message}`);

    // Send alert if configured
    const alertConnector = config.cron?.alertConnector;
    const alertChannel = config.cron?.alertChannel;
    if (alertConnector && alertChannel) {
      const alertTarget = connectors.get(alertConnector);
      if (alertTarget) {
        await alertTarget.sendMessage(
          { channel: alertChannel },
          `⚠️ Cron job "${job.name}" failed:\n${message.slice(0, 500)}`,
        ).catch((alertErr) => {
          logger.error(`Failed to send cron alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
        });
      }
    }
  }
}
