/**
 * Condition language (GRS-016c, design §2.5) — the deterministic core of Switch/IF
 * routing. A condition is a dot-path over a CLOSED grammar plus one comparison
 * operator; it is evaluated by a pure, TOTAL `evaluateCondition` over the frozen run
 * record. No LLM, no fs, no eval, no regex over untrusted input — a path is DATA
 * SELECTION against a fixed set of roots, never code, and an unknown/hostile path
 * simply resolves to `undefined` (missing), it can never reach outside the grammar.
 *
 * SECURITY BOUNDARY: conditions route control flow and their inputs include
 * step-declared handoff `fields` (untrusted model output). The containment is
 * structural: (a) the path grammar is a closed set — receipt/session/store fields
 * outside it are unreachable by construction; (b) field keys obey a shared charset
 * (FIELD_KEY_RE — no dots, no prototype-shaped names) enforced BOTH at extraction
 * (handoff.ts drops non-conforming keys) and at parse here, and field values are read
 * via own-property lookup on a null-prototype copy so `__proto__`/`constructor`
 * probing hits nothing; (c) evaluation is total — a malformed condition, a missing
 * path, a type mismatch, even a throwing evidence source all yield a boolean.
 *
 * This module is deliberately STANDALONE (imports nothing from the workflow suite) so
 * the schema validator (definition.ts) and the planner (advance.ts) can both consume
 * it without cycles; run evidence is accepted structurally via `ConditionEvidence`.
 */

import { isTodoId } from '../work-items/id.js';

/* ── Shapes ─────────────────────────────────────────────────────────────────── */

export const CONDITION_OPS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'exists', 'absent',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** Operators that take no `value` (they test presence, not comparison). */
export const VALUELESS_OPS: ReadonlySet<ConditionOp> = new Set(['exists', 'absent']);

/** The one typed Todo relationship a condition may read, and the only operators valid over it. */
const TODO_ID_CONDITION_PATH = 'trigger.payload.todoId';
const TODO_ID_CONDITION_OPS: ReadonlySet<string> = new Set(['eq', 'ne', 'exists', 'absent']);

export type ConditionValue = string | number | boolean;

export interface WorkflowCondition {
  /** Dot-path over the closed grammar (see parseConditionPath). */
  path: string;
  op: ConditionOp;
  /** JSON scalar literal; required except for exists/absent. */
  value?: ConditionValue;
}

/** Caps (authoring-time; the evaluator stays total regardless). */
export const MAX_CONDITION_PATH_CHARS = 256;
export const MAX_CONDITION_VALUE_CHARS = 256;
/** Max conditions per edge `when` array (AND-combined). */
export const MAX_EDGE_CONDITIONS = 8;

/**
 * Handoff-field key charset, shared by the extractor (handoff.ts drops keys outside
 * it) and the path grammar (a `fields.<key>` segment must match it). No dots (keys
 * must stay dot-path-addressable), no whitespace, no prototype-shaped names — the
 * charset IS the "keys colliding with path grammar tokens are refused" rule.
 */
export const FIELD_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** Prototype-shaped names the charset alone cannot exclude. Refused as field keys
 * everywhere (extraction drops them; the path grammar refuses them). */
const RESERVED_FIELD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The single field-key rule: charset + length (FIELD_KEY_RE) and not prototype-shaped. */
export function isValidFieldKey(key: unknown): key is string {
  return typeof key === 'string' && FIELD_KEY_RE.test(key) && !RESERVED_FIELD_KEYS.has(key);
}

/* ── Path grammar ───────────────────────────────────────────────────────────── */

export type StepConditionField =
  | 'status'
  | 'outcome.summary'
  | 'outcome.notes'
  | 'outcome.finalMessage'
  | 'outcome.artifacts';

export type ParsedConditionPath =
  | { root: 'steps'; nodeId: string; field: StepConditionField }
  | { root: 'steps'; nodeId: string; field: 'outcome.fields'; key: string }
  | { root: 'run'; field: 'rounds' | 'status' }
  | { root: 'trigger'; field: 'kind' | 'source' | 'event' }
  | { root: 'trigger'; field: 'payload'; key: string };

const STEP_FIELD_SUFFIXES: readonly StepConditionField[] = [
  'status',
  'outcome.summary',
  'outcome.notes',
  'outcome.finalMessage',
  'outcome.artifacts',
];

/**
 * Parse a dot-path against the CLOSED grammar:
 *
 *   path        := stepPath | runPath | triggerPath
 *   stepPath    := 'steps.' nodeId '.' ('status' | 'outcome.summary' | 'outcome.notes'
 *                  | 'outcome.finalMessage' | 'outcome.artifacts' | 'outcome.fields.' key)
 *   runPath     := 'run.rounds' | 'run.status'
 *   triggerPath := 'trigger.kind' | 'trigger.source' | 'trigger.event' | 'trigger.payload.' key
 *
 * Returns `null` for anything outside it (total, never throws). The nodeId is
 * whatever sits between the `steps.` prefix and the LONGEST matching field suffix —
 * node-id existence is the definition validator's job (it has the graph); here an
 * unknown nodeId simply resolves to a missing path at evaluation.
 */
export function parseConditionPath(raw: unknown): ParsedConditionPath | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CONDITION_PATH_CHARS) return null;
  if (raw === 'run.rounds') return { root: 'run', field: 'rounds' };
  if (raw === 'run.status') return { root: 'run', field: 'status' };
  if (raw === 'trigger.kind') return { root: 'trigger', field: 'kind' };
  if (raw === 'trigger.source') return { root: 'trigger', field: 'source' };
  if (raw === 'trigger.event') return { root: 'trigger', field: 'event' };
  if (raw.startsWith('trigger.payload.')) {
    const key = raw.slice('trigger.payload.'.length);
    return isValidFieldKey(key) ? { root: 'trigger', field: 'payload', key } : null;
  }
  if (!raw.startsWith('steps.')) return null;
  const rest = raw.slice('steps.'.length);
  // fields path: nodeId '.outcome.fields.' key — split on the LAST marker so a
  // (pathological) nodeId containing the marker still parses deterministically.
  const marker = '.outcome.fields.';
  const mi = rest.lastIndexOf(marker);
  if (mi > 0) {
    const nodeId = rest.slice(0, mi);
    const key = rest.slice(mi + marker.length);
    if (nodeId !== '' && isValidFieldKey(key)) return { root: 'steps', nodeId, field: 'outcome.fields', key };
    return null;
  }
  for (const field of STEP_FIELD_SUFFIXES) {
    const suffix = `.${field}`;
    if (rest.endsWith(suffix)) {
      const nodeId = rest.slice(0, -suffix.length);
      if (nodeId !== '' && !nodeId.endsWith('.')) return { root: 'steps', nodeId, field };
      return null;
    }
  }
  return null;
}

/* ── Evidence + resolution ──────────────────────────────────────────────────── */

/** The slice of a settled receipt a condition may read (structural — RunStepReceipt
 * satisfies it; no import to keep this module standalone). */
export interface ConditionReceiptView {
  status: string;
  outcome?: {
    summary?: string;
    notes?: string;
    finalMessage?: string;
    artifacts?: string[];
    fields?: Record<string, ConditionValue>;
  };
}

/**
 * The frozen-run evidence a condition evaluates over. `receiptFor` implements the
 * design's resolution rule — "the latest SETTLED receipt of that node at or before
 * the evaluating node's own position in steps[]" (the same position-based rule the
 * prompt builder uses, so routing and handoffs can never disagree); a node with no
 * settled receipt yet (unsettled sibling branch, not-yet-spliced round, unknown id)
 * returns null → the path is missing → `absent` semantics.
 */
export interface ConditionEvidence {
  receiptFor(nodeId: string): ConditionReceiptView | null;
  /** run.rounds — absent on loop-less records (missing path, not 1). */
  rounds?: number;
  runStatus: string;
  triggerKind: string;
  trigger?: {
    source: string;
    event: string;
    payload: Record<string, unknown>;
    fireRef?: string;
  };
}

/** Resolve a parsed path to its value, or `undefined` when missing. Total. */
function resolveParsedPath(parsed: ParsedConditionPath, ev: ConditionEvidence): unknown {
  switch (parsed.root) {
    case 'run':
      return parsed.field === 'rounds' ? ev.rounds : ev.runStatus;
    case 'trigger':
      if (parsed.field === 'kind' || parsed.field === 'source') return ev.trigger?.source ?? ev.triggerKind;
      if (parsed.field === 'event') return ev.trigger?.event;
      if (parsed.field === 'payload') {
        const payload = ev.trigger?.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
        if (!Object.prototype.hasOwnProperty.call(payload, parsed.key)) return undefined;
        const v = payload[parsed.key];
        return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
      }
      return undefined;
    case 'steps': {
      const receipt = ev.receiptFor(parsed.nodeId);
      if (!receipt) return undefined;
      if (parsed.field === 'status') return receipt.status;
      const outcome = receipt.outcome;
      if (!outcome || typeof outcome !== 'object') return undefined;
      switch (parsed.field) {
        case 'outcome.summary': return typeof outcome.summary === 'string' ? outcome.summary : undefined;
        case 'outcome.notes': return typeof outcome.notes === 'string' ? outcome.notes : undefined;
        case 'outcome.finalMessage': return typeof outcome.finalMessage === 'string' ? outcome.finalMessage : undefined;
        case 'outcome.artifacts': return Array.isArray(outcome.artifacts) ? outcome.artifacts : undefined;
        case 'outcome.fields': {
          const fields = outcome.fields;
          if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
          // Own-property read on a hostile-key-proof lookup: the key charset already
          // excludes __proto__/constructor shapes, and hasOwnProperty guards against
          // anything inherited on a hand-crafted record.
          if (!Object.prototype.hasOwnProperty.call(fields, parsed.key)) return undefined;
          const v = (fields as Record<string, unknown>)[parsed.key];
          return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
        }
      }
    }
  }
}

/* ── Evaluation (TOTAL) ─────────────────────────────────────────────────────── */

const isScalar = (v: unknown): v is ConditionValue =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * Evaluate ONE condition over the evidence. TOTAL: any input — corrupt condition,
 * missing path, type mismatch, throwing evidence — yields a boolean, never a throw.
 *
 * Semantics (design §2.5):
 *   - missing path → `exists` false, `absent` true, every comparison false;
 *   - eq/ne compare same-type scalars (type mismatch → eq false, ne true); arrays
 *     never eq/ne anything;
 *   - gt/gte/lt/lte require both sides finite numbers, else false (no coercion);
 *   - contains: string substring; on artifacts, true iff any element contains it;
 *   - startsWith: strings only;
 *   - strings compare case-sensitively.
 */
export function evaluateCondition(cond: WorkflowCondition, ev: ConditionEvidence): boolean {
  // Capture the condition's fields FIRST, under their own guard (GRS-016c-fix,
  // Codex finding 1): a hostile condition OBJECT (throwing accessor, proxy trap)
  // must be as harmless as a hostile run record. Authoring validation already
  // refuses non-plain condition shapes (validateConditionShape); this is the
  // belt-and-braces layer — after these three reads, `op`/`path`/`value` are
  // local bindings and no property of `cond` is ever touched again (the old catch
  // path re-read `cond.op` and could be made to throw twice).
  let op: unknown;
  let path: unknown;
  let value: unknown;
  let todoValueDescriptor: PropertyDescriptor | undefined;
  try {
    if (!cond || typeof cond !== 'object') return false;
    const c = cond as unknown as Record<string, unknown>;
    op = c.op;
    path = c.path;
    if (path === TODO_ID_CONDITION_PATH) {
      todoValueDescriptor = Object.getOwnPropertyDescriptor(c, 'value');
      if (todoValueDescriptor && !('value' in todoValueDescriptor)) return false;
      value = todoValueDescriptor?.value;
    } else {
      value = c.value;
    }
  } catch {
    return false; // a condition whose own fields cannot be read matches nothing
  }
  if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) return false;
  if (path === TODO_ID_CONDITION_PATH) {
    if (!TODO_ID_CONDITION_OPS.has(op)) return false;
    if (VALUELESS_OPS.has(op as ConditionOp)) {
      if (todoValueDescriptor !== undefined) return false;
    } else if (!todoValueDescriptor || !isTodoId(value)) {
      return false;
    }
  }
  try {
    const parsed = parseConditionPath(path);
    const resolved = parsed ? resolveParsedPath(parsed, ev) : undefined;

    if (path === TODO_ID_CONDITION_PATH && resolved !== undefined && !isTodoId(resolved)) return false;

    if (op === 'exists') return resolved !== undefined;
    if (op === 'absent') return resolved === undefined;
    if (resolved === undefined) return false; // missing path: every comparison false

    switch (op) {
      case 'eq':
        return isScalar(resolved) && isScalar(value) && typeof resolved === typeof value && resolved === value;
      case 'ne':
        // Type mismatch → ne true (they ARE different); but arrays/objects and a
        // missing/corrupt value never satisfy any comparison.
        if (!isScalar(resolved) || !isScalar(value)) return false;
        return typeof resolved !== typeof value || resolved !== value;
      case 'gt': case 'gte': case 'lt': case 'lte': {
        if (typeof resolved !== 'number' || typeof value !== 'number') return false;
        if (!Number.isFinite(resolved) || !Number.isFinite(value)) return false;
        return op === 'gt' ? resolved > value
          : op === 'gte' ? resolved >= value
          : op === 'lt' ? resolved < value
          : resolved <= value;
      }
      case 'contains': {
        if (typeof value !== 'string') return false;
        if (typeof resolved === 'string') return resolved.includes(value);
        if (Array.isArray(resolved)) return resolved.some((el) => typeof el === 'string' && el.includes(value));
        return false;
      }
      case 'startsWith':
        return typeof resolved === 'string' && typeof value === 'string' && resolved.startsWith(value);
      default:
        return false;
    }
  } catch {
    // Evidence sources are injected; even a throwing one must not crash routing.
    // A throw during resolution means the value is unknowable → absent-like
    // fallback. `op` is a captured primitive string here — this read is total.
    return op === 'absent';
  }
}

/** AND over a `when` array (design §2.3). Empty/absent = vacuously true (an edge
 * with no conditions always matches); a non-array — or an array whose elements
 * cannot even be READ (hostile index accessors) — is corrupt → false, never a throw. */
export function evaluateConditions(conds: WorkflowCondition[] | undefined, ev: ConditionEvidence): boolean {
  try {
    if (conds === undefined) return true;
    if (!Array.isArray(conds)) return false;
    return conds.every((c) => evaluateCondition(c, ev));
  } catch {
    return false;
  }
}

/* ── Authoring-time shape validation ────────────────────────────────────────── */

const CONDITION_KEYS = new Set(['path', 'op', 'value']);

/**
 * True for a PLAIN DATA object: prototype is Object.prototype or null, and every
 * own property (string- and symbol-keyed) is a data property — no accessors. This
 * is the authoring-side gate against hostile condition objects (GRS-016c-fix,
 * Codex finding 1): everything a JSON body can produce passes; getters, class
 * instances, and objects with foreign prototypes are refused BEFORE any field is
 * read, so validation itself can never be made to throw by a crafted property.
 * (A full Proxy can still lie to these checks — the caller's try/catch and the
 * evaluator's total field capture are the layers behind this one.)
 */
function isPlainDataObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of [...Object.getOwnPropertyNames(v), ...Object.getOwnPropertySymbols(v)]) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d || d.get !== undefined || d.set !== undefined) return false;
  }
  return true;
}

/**
 * Validate ONE condition's SHAPE for the definition validator (strict, unlike the
 * total evaluator): unknown keys, unparseable paths, unknown ops, missing/miskinded
 * values are authoring errors — a condition that could never pass (or could only
 * pass vacuously) must fail at save time, not silently route to the default branch.
 * The condition must be a PLAIN DATA object (isPlainDataObject) — an agent-authored
 * definition arriving through create_workflow/PUT is JSON and always is; an
 * in-process caller handing us accessors/proxies gets a validation error, never a
 * throw (the whole body is guarded). Node-id existence is checked by the caller
 * (it owns the graph). Returns reasons; empty = valid.
 */
export function validateConditionShape(cond: unknown): string[] {
  try {
    return validateConditionShapeInner(cond);
  } catch {
    // A proxy trap fired during inspection — hostile by definition.
    return ['condition failed shape inspection (non-plain or hostile object)'];
  }
}

function validateConditionShapeInner(cond: unknown): string[] {
  if (!isPlainDataObject(cond)) {
    return ['condition must be a plain object { path, op, value? } with data properties only'];
  }
  const errors: string[] = [];
  const c = cond;
  for (const key of Object.keys(c)) {
    if (!CONDITION_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  }
  const parsed = parseConditionPath(c.path);
  if (!parsed) {
    errors.push(
      `path must match the condition grammar (steps.<nodeId>.status | steps.<nodeId>.outcome.summary|notes|finalMessage|artifacts | steps.<nodeId>.outcome.fields.<key> | run.rounds | run.status | trigger.kind|source|event | trigger.payload.<key>)`,
    );
  }
  const op = c.op;
  if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) {
    errors.push(`op must be one of ${CONDITION_OPS.join(' | ')}`);
    return errors; // value rules are op-specific; meaningless without a known op
  }
  const valueless = VALUELESS_OPS.has(op as ConditionOp);
  // Todo identity is an exact-match namespace, never an ordered or substring one.
  if (c.path === TODO_ID_CONDITION_PATH) {
    if (!TODO_ID_CONDITION_OPS.has(op)) {
      errors.push(`op "${op}" is not permitted on ${TODO_ID_CONDITION_PATH}; use eq, ne, exists, or absent`);
      return errors;
    }
    const valueDescriptor = Object.getOwnPropertyDescriptor(c, 'value');
    if (valueless) {
      if (valueDescriptor !== undefined) errors.push(`op "${op}" takes no value`);
      return errors;
    }
    if (!valueDescriptor || !('value' in valueDescriptor) || !isTodoId(valueDescriptor.value)) {
      errors.push(`${TODO_ID_CONDITION_PATH} requires a canonical Todo ID value`);
    }
    return errors;
  }
  if (valueless) {
    if (c.value !== undefined) errors.push(`op "${op}" takes no value`);
    return errors;
  }
  const value = c.value;
  if (value === undefined) {
    errors.push(`op "${op}" requires a value`);
    return errors;
  }
  if (!isScalar(value)) {
    errors.push('value must be a string, number, or boolean');
    return errors;
  }
  if (typeof value === 'string' && value.length > MAX_CONDITION_VALUE_CHARS) {
    errors.push(`value exceeds ${MAX_CONDITION_VALUE_CHARS} chars`);
  }
  if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && (typeof value !== 'number' || !Number.isFinite(value))) {
    errors.push(`op "${op}" requires a finite numeric value`);
  }
  if ((op === 'contains' || op === 'startsWith') && typeof value !== 'string') {
    errors.push(`op "${op}" requires a string value`);
  }
  return errors;
}
