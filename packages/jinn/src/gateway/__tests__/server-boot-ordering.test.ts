import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
  'utf8',
);

function callIndex(expr: string): number {
  const i = serverSource.indexOf(expr);
  expect(i, `boot call site "${expr}" not found in server.ts — re-assert the GRS-014d boot ordering`).toBeGreaterThan(-1);
  return i;
}

describe('gateway boot ordering', () => {
  it('settles orphaned workflow attempts once before workflow recovery and listen', () => {
    const sweep = callIndex('recoverStaleWorkflowAttemptSessions()');
    const recover = callIndex('await workflowService.recover(new Date().toISOString())');
    const listen = callIndex('server.listen(port, host)');

    expect(sweep).toBeLessThan(recover);
    expect(sweep).toBeLessThan(listen);
    expect(serverSource.indexOf('recoverStaleWorkflowAttemptSessions()', sweep + 1)).toBe(-1);
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

});
