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
});
