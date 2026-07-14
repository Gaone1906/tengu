import { describe, it, expect } from 'vitest';
import {
  CONDITION_OPS,
  FIELD_KEY_RE,
  MAX_EDGE_CONDITIONS,
  evaluateCondition,
  evaluateConditions,
  parseConditionPath,
  validateConditionShape,
  type ConditionEvidence,
  type WorkflowCondition,
} from '../condition.js';

/**
 * GRS-016c condition-language suite — the SECURITY-SENSITIVE deterministic core of
 * Switch/IF routing. The evaluator must be TOTAL: any condition (including a corrupt
 * or hostile one) over any run record evaluates to a boolean, never a throw. This
 * suite pins the closed path grammar, every operator's semantics against every value
 * shape (missing / type mismatch / arrays), and the totality guarantee.
 */

/** Evidence over a tiny fake run: `review` settled with a declared handoff. */
function evidence(over: Partial<ConditionEvidence> = {}): ConditionEvidence {
  return {
    receiptFor: (nodeId: string) =>
      nodeId === 'review'
        ? {
            status: 'done',
            outcome: {
              summary: 'Reviewed the change',
              notes: 'watch the cache',
              finalMessage: 'All done. Ship it.',
              artifacts: ['reports/review.md', 'src/a.ts'],
              fields: { verdict: 'ship', bugCount: 3, needsHuman: false, zero: 0, empty: '' as string },
            },
          }
        : nodeId === 'bare'
          ? { status: 'skipped' }
          : null,
    rounds: 2,
    runStatus: 'running',
    triggerKind: 'manual',
    ...over,
  };
}

const cond = (path: string, op: WorkflowCondition['op'], value?: string | number | boolean): WorkflowCondition =>
  ({ path, op, ...(value !== undefined ? { value } : {}) });

/* ── Path grammar (closed set) ──────────────────────────────────────────────── */

describe('parseConditionPath — the closed grammar', () => {
  it('parses every legal root', () => {
    expect(parseConditionPath('steps.review.status')).toEqual({ root: 'steps', nodeId: 'review', field: 'status' });
    expect(parseConditionPath('steps.review.outcome.summary')).toEqual({ root: 'steps', nodeId: 'review', field: 'outcome.summary' });
    expect(parseConditionPath('steps.review.outcome.notes')).toEqual({ root: 'steps', nodeId: 'review', field: 'outcome.notes' });
    expect(parseConditionPath('steps.review.outcome.finalMessage')).toEqual({ root: 'steps', nodeId: 'review', field: 'outcome.finalMessage' });
    expect(parseConditionPath('steps.review.outcome.artifacts')).toEqual({ root: 'steps', nodeId: 'review', field: 'outcome.artifacts' });
    expect(parseConditionPath('steps.review.outcome.fields.verdict')).toEqual({ root: 'steps', nodeId: 'review', field: 'outcome.fields', key: 'verdict' });
    expect(parseConditionPath('run.rounds')).toEqual({ root: 'run', field: 'rounds' });
    expect(parseConditionPath('run.status')).toEqual({ root: 'run', field: 'status' });
    expect(parseConditionPath('trigger.kind')).toEqual({ root: 'trigger', field: 'kind' });
    expect(parseConditionPath('trigger.source')).toEqual({ root: 'trigger', field: 'source' });
    expect(parseConditionPath('trigger.event')).toEqual({ root: 'trigger', field: 'event' });
    expect(parseConditionPath('trigger.payload.toStatus')).toEqual({ root: 'trigger', field: 'payload', key: 'toStatus' });
  });

  it('refuses everything outside the grammar (closed set, no traversal)', () => {
    for (const bad of [
      '', ' ', 'steps', 'steps.', 'steps.review', 'steps.review.', 'steps.review.outcome',
      'steps.review.outcome.', 'steps.review.outcome.bogus', 'steps..status',
      'steps.review.sessionId',                 // receipt fields outside the grammar stay unreachable
      'steps.review.outcome.fields.',           // empty key
      'steps.review.outcome.fields.a.b',        // nested key — flat map only
      'steps.review.outcome.fields.__proto__',  // hostile key shapes refused by the key charset
      'steps.review.outcome.fields.a b',
      'run.errors', 'run.steps', 'run.', 'run',
      'trigger.cronJobId', 'trigger.payload', 'trigger.payload.', 'trigger.payload.a.b',
      'trigger.payload.__proto__', 'trigger.', 'trigger',
      'constructor.prototype', '__proto__.x', 'a.b.c',
    ]) {
      expect(parseConditionPath(bad), bad).toBeNull();
    }
    expect(parseConditionPath(42 as unknown as string)).toBeNull();
    expect(parseConditionPath(null as unknown as string)).toBeNull();
  });

  it('field keys obey the shared charset (letters/digits/_/-, ≤64)', () => {
    expect(FIELD_KEY_RE.test('verdict')).toBe(true);
    expect(FIELD_KEY_RE.test('bug-count_2')).toBe(true);
    expect(FIELD_KEY_RE.test('-lead')).toBe(false); // must start alphanumeric or _
    expect(FIELD_KEY_RE.test('a'.repeat(64))).toBe(true);
    expect(FIELD_KEY_RE.test('a'.repeat(65))).toBe(false);
    expect(FIELD_KEY_RE.test('a.b')).toBe(false);
  });
});

/* ── Evaluation: every operator against every value shape ───────────────────── */

describe('evaluateCondition — operators', () => {
  const ev = evidence();

  it('eq/ne: same-type strict comparison; type mismatch → eq false, ne true', () => {
    expect(evaluateCondition(cond('steps.review.outcome.fields.verdict', 'eq', 'ship'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.verdict', 'eq', 'reject'), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.fields.verdict', 'ne', 'reject'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'eq', 3), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.needsHuman', 'eq', false), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.needsHuman', 'eq', true), ev)).toBe(false);
    // type mismatch: number field vs string value
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'eq', '3'), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'ne', '3'), ev)).toBe(true);
    // boolean vs number
    expect(evaluateCondition(cond('steps.review.outcome.fields.needsHuman', 'eq', 0), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.fields.needsHuman', 'ne', 0), ev)).toBe(true);
    // strings compare case-sensitively
    expect(evaluateCondition(cond('steps.review.outcome.fields.verdict', 'eq', 'Ship'), ev)).toBe(false);
    // falsy-but-present scalars are honest values, not "missing"
    expect(evaluateCondition(cond('steps.review.outcome.fields.zero', 'eq', 0), ev)).toBe(true);
  });

  it('eq/ne on an array value (artifacts) is always false (arrays are not scalars)', () => {
    expect(evaluateCondition(cond('steps.review.outcome.artifacts', 'eq', 'reports/review.md'), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.artifacts', 'ne', 'reports/review.md'), ev)).toBe(false);
  });

  it('gt/gte/lt/lte: both sides numeric, else false', () => {
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'gt', 2), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'gt', 3), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'gte', 3), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'lt', 4), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'lte', 3), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'lte', 2), ev)).toBe(false);
    expect(evaluateCondition(cond('run.rounds', 'gte', 2), ev)).toBe(true);
    expect(evaluateCondition(cond('run.rounds', 'gt', 2), ev)).toBe(false);
    // string resolved value → ordering is false, never a coercion
    expect(evaluateCondition(cond('steps.review.outcome.fields.verdict', 'gt', 0), ev)).toBe(false);
    // string VALUE against numeric field → false (no '3' coercion)
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'gt', '2' as unknown as number), ev)).toBe(false);
    // boolean is not numeric
    expect(evaluateCondition(cond('steps.review.outcome.fields.needsHuman', 'lt', 1), ev)).toBe(false);
  });

  it('contains: string substring; on artifacts, any element contains', () => {
    expect(evaluateCondition(cond('steps.review.outcome.summary', 'contains', 'the change'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.summary', 'contains', 'THE CHANGE'), ev)).toBe(false); // case-sensitive
    expect(evaluateCondition(cond('steps.review.outcome.artifacts', 'contains', 'review.md'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.artifacts', 'contains', 'nope.md'), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.finalMessage', 'contains', 'Ship it'), ev)).toBe(true);
    // non-string value → false, no stringification
    expect(evaluateCondition(cond('steps.review.outcome.summary', 'contains', 3 as unknown as string), ev)).toBe(false);
    // number field → false
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'contains', '3'), ev)).toBe(false);
  });

  it('startsWith: strings only', () => {
    expect(evaluateCondition(cond('steps.review.outcome.summary', 'startsWith', 'Reviewed'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.summary', 'startsWith', 'reviewed'), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.artifacts', 'startsWith', 'reports/'), ev)).toBe(false); // arrays: contains only
    expect(evaluateCondition(cond('steps.review.outcome.fields.bugCount', 'startsWith', '3'), ev)).toBe(false);
  });

  it('exists/absent over every value shape', () => {
    expect(evaluateCondition(cond('steps.review.outcome.fields.verdict', 'exists'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.verdict', 'absent'), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.fields.nope', 'exists'), ev)).toBe(false);
    expect(evaluateCondition(cond('steps.review.outcome.fields.nope', 'absent'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.artifacts', 'exists'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.status', 'exists'), ev)).toBe(true);
    // falsy-but-present values still exist
    expect(evaluateCondition(cond('steps.review.outcome.fields.zero', 'exists'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.empty', 'exists'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.review.outcome.fields.needsHuman', 'exists'), ev)).toBe(true);
  });

  it('status / run / trigger paths resolve', () => {
    expect(evaluateCondition(cond('steps.review.status', 'eq', 'done'), ev)).toBe(true);
    expect(evaluateCondition(cond('steps.bare.status', 'eq', 'skipped'), ev)).toBe(true);
    expect(evaluateCondition(cond('run.status', 'eq', 'running'), ev)).toBe(true);
    expect(evaluateCondition(cond('trigger.kind', 'eq', 'manual'), ev)).toBe(true);
    expect(evaluateCondition(cond('trigger.kind', 'ne', 'schedule'), ev)).toBe(true);
  });

  it('reads the normalized trigger event and payload', () => {
    const ev = evidence({
      trigger: {
        source: 'todo-status-change',
        event: 'todo.status_changed',
        payload: { todoId: 'JIN-1', fromStatus: 'executing', toStatus: 'in_review', count: 2, matched: true },
        fireRef: 'wie_evt1',
      },
    });

    expect(evaluateCondition(cond('trigger.source', 'eq', 'todo-status-change'), ev)).toBe(true);
    expect(evaluateCondition(cond('trigger.event', 'eq', 'todo.status_changed'), ev)).toBe(true);
    expect(evaluateCondition(cond('trigger.payload.todoId', 'eq', 'JIN-1'), ev)).toBe(true);
    expect(evaluateCondition(cond('trigger.payload.toStatus', 'eq', 'in_review'), ev)).toBe(true);
    expect(evaluateCondition(cond('trigger.payload.count', 'gte', 2), ev)).toBe(true);
    expect(evaluateCondition(cond('trigger.payload.matched', 'eq', true), ev)).toBe(true);
    expect(evaluateCondition(cond('trigger.payload.missing', 'absent'), ev)).toBe(true);
  });
});

/* ── Totality: missing paths, corrupt conditions — never a throw ────────────── */

describe('evaluateCondition — totality guarantee', () => {
  const ev = evidence();

  it('missing path → exists false, absent true, EVERY comparison false (incl. ne)', () => {
    for (const path of [
      'steps.ghost.status',                       // unknown node
      'steps.ghost.outcome.fields.verdict',
      'steps.bare.outcome.summary',               // receipt with no outcome
      'steps.bare.outcome.fields.verdict',
      'steps.review.outcome.fields.missingKey',   // known node, undeclared field
      'not.a.path',                               // unparseable
    ]) {
      expect(evaluateCondition(cond(path, 'exists'), ev), `${path} exists`).toBe(false);
      expect(evaluateCondition(cond(path, 'absent'), ev), `${path} absent`).toBe(true);
      for (const op of CONDITION_OPS) {
        if (op === 'exists' || op === 'absent') continue;
        expect(evaluateCondition(cond(path, op, 'x'), ev), `${path} ${op}`).toBe(false);
        expect(evaluateCondition(cond(path, op, 1), ev), `${path} ${op} number`).toBe(false);
      }
    }
  });

  it('run.rounds is absent on a loop-less record', () => {
    const bare = evidence({ rounds: undefined });
    expect(evaluateCondition(cond('run.rounds', 'exists'), bare)).toBe(false);
    expect(evaluateCondition(cond('run.rounds', 'absent'), bare)).toBe(true);
    expect(evaluateCondition(cond('run.rounds', 'gte', 1), bare)).toBe(false);
  });

  it('corrupt condition shapes never throw: unknown op, missing value, junk types', () => {
    expect(evaluateCondition({ path: 'steps.review.status', op: 'matches' as never, value: '.*' }, ev)).toBe(false);
    expect(evaluateCondition({ path: 'steps.review.status', op: 'eq' } as WorkflowCondition, ev)).toBe(false);
    expect(evaluateCondition({ path: 'steps.review.status', op: 'ne' } as WorkflowCondition, ev)).toBe(false);
    expect(evaluateCondition({ path: 42, op: 'eq', value: 'x' } as unknown as WorkflowCondition, ev)).toBe(false);
    expect(evaluateCondition(null as unknown as WorkflowCondition, ev)).toBe(false);
    expect(evaluateCondition({ path: 'steps.review.status', op: 'eq', value: { deep: true } } as unknown as WorkflowCondition, ev)).toBe(false);
    expect(evaluateCondition({ path: 'steps.review.status', op: 'eq', value: ['done'] } as unknown as WorkflowCondition, ev)).toBe(false);
  });

  it('a hostile receiptFor (throwing evidence) is contained — evaluate returns false', () => {
    const hostile = evidence({
      receiptFor: () => {
        throw new Error('store exploded');
      },
    });
    expect(evaluateCondition(cond('steps.review.status', 'eq', 'done'), hostile)).toBe(false);
    expect(evaluateCondition(cond('steps.review.status', 'absent'), hostile)).toBe(true);
  });
});

/* ── AND combination ────────────────────────────────────────────────────────── */

describe('evaluateConditions — AND within the array', () => {
  const ev = evidence();
  it('all must pass; empty/absent array is vacuously true', () => {
    expect(evaluateConditions([
      cond('steps.review.outcome.fields.verdict', 'eq', 'ship'),
      cond('steps.review.outcome.fields.bugCount', 'lte', 5),
    ], ev)).toBe(true);
    expect(evaluateConditions([
      cond('steps.review.outcome.fields.verdict', 'eq', 'ship'),
      cond('steps.review.outcome.fields.bugCount', 'gt', 5),
    ], ev)).toBe(false);
    expect(evaluateConditions([], ev)).toBe(true);
    expect(evaluateConditions(undefined, ev)).toBe(true);
    expect(evaluateConditions('junk' as unknown as WorkflowCondition[], ev)).toBe(false);
  });
});

/* ── Authoring-time shape validation ────────────────────────────────────────── */

describe('validateConditionShape — authoring strictness', () => {
  it('accepts every legal shape', () => {
    expect(validateConditionShape(cond('steps.review.outcome.fields.verdict', 'eq', 'ship'))).toEqual([]);
    expect(validateConditionShape(cond('steps.review.outcome.fields.bugCount', 'gte', 2))).toEqual([]);
    expect(validateConditionShape(cond('steps.review.outcome.fields.needsHuman', 'eq', true))).toEqual([]);
    expect(validateConditionShape(cond('steps.review.outcome.artifacts', 'contains', 'review.md'))).toEqual([]);
    expect(validateConditionShape(cond('steps.review.outcome.fields.verdict', 'exists'))).toEqual([]);
    expect(validateConditionShape(cond('run.rounds', 'lt', 3))).toEqual([]);
    expect(validateConditionShape(cond('trigger.kind', 'eq', 'schedule'))).toEqual([]);
    expect(validateConditionShape(cond('trigger.source', 'eq', 'schedule'))).toEqual([]);
    expect(validateConditionShape(cond('trigger.event', 'eq', 'schedule.fire'))).toEqual([]);
    expect(validateConditionShape(cond('trigger.payload.toStatus', 'eq', 'in_review'))).toEqual([]);
  });

  it('refuses corrupt shapes with a reason', () => {
    expect(validateConditionShape(null).length).toBeGreaterThan(0);
    expect(validateConditionShape('x').length).toBeGreaterThan(0);
    expect(validateConditionShape([cond('run.rounds', 'eq', 1)]).length).toBeGreaterThan(0); // array is not a condition
    expect(validateConditionShape({ op: 'eq', value: 'x' }).length).toBeGreaterThan(0); // no path
    expect(validateConditionShape(cond('steps.review.bogus', 'eq', 'x')).length).toBeGreaterThan(0); // outside grammar
    expect(validateConditionShape({ path: 'run.status', op: 'matches', value: '.*' }).length).toBeGreaterThan(0); // unknown op
    expect(validateConditionShape({ path: 'run.status', op: 'eq' }).length).toBeGreaterThan(0); // value required
    expect(validateConditionShape({ path: 'run.status', op: 'eq', value: { a: 1 } }).length).toBeGreaterThan(0); // non-scalar
    expect(validateConditionShape({ path: 'run.status', op: 'exists', value: 'x' }).length).toBeGreaterThan(0); // exists takes no value
    expect(validateConditionShape({ path: 'run.rounds', op: 'gt', value: '2' }).length).toBeGreaterThan(0); // ordering needs a number
    expect(validateConditionShape({ path: 'run.rounds', op: 'gt', value: Number.NaN }).length).toBeGreaterThan(0);
    expect(validateConditionShape({ path: 'run.status', op: 'contains', value: 7 }).length).toBeGreaterThan(0); // contains needs a string
    expect(validateConditionShape({ path: 'run.status', op: 'startsWith', value: true }).length).toBeGreaterThan(0);
    expect(validateConditionShape({ path: `steps.${'a'.repeat(300)}.status`, op: 'exists' }).length).toBeGreaterThan(0); // path cap
    expect(validateConditionShape({ path: 'run.status', op: 'eq', value: 'x'.repeat(300) }).length).toBeGreaterThan(0); // value cap
    expect(validateConditionShape({ path: 'run.status', op: 'eq', value: 'x', extra: 1 }).length).toBeGreaterThan(0); // unknown keys refused
  });

  it('exports the per-edge condition cap for the definition validator', () => {
    expect(MAX_EDGE_CONDITIONS).toBeGreaterThanOrEqual(1);
  });
});

/* ── Hostile condition OBJECTS (GRS-016c-fix, Codex finding 1) ──────────────── */

describe('hostile condition objects — the definition side is total too', () => {
  const ev = evidence();
  const withThrowingField = (field: string) =>
    Object.defineProperty(
      { path: 'run.status', op: 'eq', value: 'running' },
      field,
      { get() { throw new Error(`${field} getter`); } },
    ) as unknown as WorkflowCondition;

  it('a throwing accessor on ANY condition field never throws out of the evaluator', () => {
    for (const field of ['op', 'path', 'value']) {
      expect(() => evaluateCondition(withThrowingField(field), ev), field).not.toThrow();
      expect(evaluateCondition(withThrowingField(field), ev), field).toBe(false);
    }
  });

  it('a full proxy trap (get/getPrototypeOf throw) never throws out of the evaluator', () => {
    const proxy = new Proxy({}, {
      get() { throw new Error('trap'); },
      getPrototypeOf() { throw new Error('trap'); },
    }) as unknown as WorkflowCondition;
    expect(() => evaluateCondition(proxy, ev)).not.toThrow();
    expect(evaluateCondition(proxy, ev)).toBe(false);
  });

  it('evaluateConditions survives a hostile ARRAY (throwing element accessor)', () => {
    const arr: WorkflowCondition[] = [];
    Object.defineProperty(arr, 0, { get() { throw new Error('element getter'); } });
    (arr as unknown as { length: number }).length = 1;
    expect(() => evaluateConditions(arr, ev)).not.toThrow();
    expect(evaluateConditions(arr, ev)).toBe(false);
  });

  it('validateConditionShape refuses non-plain condition shapes WITHOUT throwing', () => {
    for (const hostile of [
      withThrowingField('op'),
      withThrowingField('path'),
      new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } }),
      Object.create({ path: 'run.status', op: 'eq', value: 'x' }), // inherited props, no own data
      new (class Cond { path = 'run.status'; op = 'eq'; value = 'x' })(), // class instance prototype
    ]) {
      expect(() => validateConditionShape(hostile)).not.toThrow();
      expect(validateConditionShape(hostile).length).toBeGreaterThan(0);
    }
    // null-prototype PLAIN DATA is fine (nothing to trap; JSON never produces it but it is safe)
    const bare = Object.assign(Object.create(null), { path: 'run.status', op: 'eq', value: 'running' });
    expect(validateConditionShape(bare)).toEqual([]);
  });
});
