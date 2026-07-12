import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GRS-014d-fix (Codex finding 3) — boot-ordering regression guard.
 *
 * The invariant: by the time `startScheduler` arms the first possible cron tick,
 * (1) jobs.json has been healed against the definition store (`applyWorkflowCronSync`)
 * and (2) the managed-workflow fire handler is wired (`setWorkflowCronFire`). The
 * round-1 bug had the scheduler starting ~150 lines before the handler wiring, so a
 * managed job due exactly at boot fired handler-less, appended a terminal error row,
 * and permanently missed that scheduled run (the run-log guard then blocked a
 * same-fireIso retry).
 *
 * No test harness boots the real gateway in-process (startGateway spawns engines,
 * watchers, connectors), so this is a STRUCTURAL test over the boot source: it pins
 * the relative order of the three call sites. Deliberately narrow — it matches the
 * exact call expressions, so a refactor that renames them will fail loudly here and
 * force the author to re-assert the ordering rather than lose it silently.
 */

const serverSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
  'utf8',
);

function callIndex(expr: string): number {
  const i = serverSource.indexOf(expr);
  expect(i, `boot call site "${expr}" not found in server.ts — re-assert the GRS-014d boot ordering`).toBeGreaterThan(-1);
  return i;
}

describe('gateway boot ordering — managed cron fires can never land half-wired', () => {
  it('heals jobs.json AND wires the workflow fire handler BEFORE the scheduler starts', () => {
    const sync = callIndex('applyWorkflowCronSync(workflowEvidenceRoot');
    const wire = callIndex('setWorkflowCronFire(workflowCronFireHandler(apiContext))');
    const scheduler = callIndex('startScheduler(cronJobs');

    expect(sync).toBeLessThan(scheduler);
    expect(wire).toBeLessThan(scheduler);
  });

  it('clears the fire handler at shutdown after stopping the scheduler', () => {
    const stop = callIndex('stopScheduler();');
    const clear = callIndex('setWorkflowCronFire(undefined)');
    expect(clear).toBeGreaterThan(stop);
  });

  it('defers the work-item startup reconcile past server.listen() (perf: accept requests first)', () => {
    const listen = callIndex('server.listen(port, host)');
    const reconcile = callIndex('reconcileWorkItemsOnStartup()');
    // The only invocation of the startup reconcile must run AFTER listen() — it is
    // best-effort + idempotent + covered by the periodic reconciler, so it must not
    // block boot. A refactor that re-adds a pre-listen synchronous call fails here.
    expect(reconcile).toBeGreaterThan(listen);
    expect(serverSource.indexOf('reconcileWorkItemsOnStartup()', reconcile + 1)).toBe(-1);
    // And it is deferred onto a setImmediate tick rather than run inline post-listen.
    const immediate = callIndex('setImmediate(() => {');
    expect(reconcile).toBeGreaterThan(immediate);
  });

  it('starts the yielded FTS backfill only after server.listen()', () => {
    const listen = callIndex('server.listen(port, host)');
    const backfill = callIndex('scheduleFtsBackfill()');

    expect(backfill).toBeGreaterThan(listen);
    expect(serverSource.indexOf('scheduleFtsBackfill()', backfill + 1)).toBe(-1);
  });

  it('defers stranded-partial maintenance until after server.listen()', () => {
    const listen = callIndex('server.listen(port, host)');
    const sweep = callIndex('clearAllPartialMessages()');

    expect(sweep).toBeGreaterThan(listen);
    expect(serverSource.indexOf('clearAllPartialMessages()', sweep + 1)).toBe(-1);
  });

  it('arms the jinn MCP attach gate before replaying pending web queue items', () => {
    const listen = callIndex('server.listen(port, host)');
    const arm = callIndex('await armJinnAttachGate(currentConfig.mcp');
    const replay = serverSource.indexOf('resumePendingWebQueueItems(apiContext)', arm);

    expect(arm).toBeGreaterThan(listen);
    expect(replay).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(arm);
  });

  it('retries persisted pending callback queues after engines/configuration reload', () => {
    const reloadStart = callIndex('const reloadConfig = (): void =>');
    const reloadEnd = callIndex('apiContext.reloadConfig = reloadConfig');
    const reloadBody = serverSource.slice(reloadStart, reloadEnd);

    expect(reloadBody).toContain('resumePendingWebQueueItems(apiContext)');
  });

  it('reconstructs Workflow activity and missing claims before the single Session delivery recovery call', () => {
    const reconstruct = callIndex('recoverWorkflowRunReporting(workflowEvidenceRoot');
    const recover = callIndex('recoverSessionDeliveryStateOnStartup()');

    expect(reconstruct).toBeLessThan(recover);
    expect(serverSource.indexOf('recoverSessionDeliveryStateOnStartup()', recover + 1)).toBe(-1);
  });
});
