import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkItem } from '../work-items/store.js';
import { startWorkflowRunFromTrigger, type RunDriverDeps } from './run-reconciler.js';
import type { WorkflowRun, WorkflowTriggerEvent } from './run-store.js';
import { evaluateRegexMatch } from './regex-eval.js';
import { logger } from '../shared/logger.js';
import { snapshotPollExecutableArtifacts, type PollExecutableArtifact } from './poll-artifacts.js';
import { abortPollExecutions } from './poll-executions.js';
import { resolveActiveTriggerDefinition } from './trigger-dispatch.js';

const TRIGGER_STORE_SCHEMA_VERSION = 1;
const TRIGGER_DIR = 'workflow-triggers';
const TRIGGER_FILE = 'triggers.json';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_CHARS = 128;
const MAX_EVENT_CHARS = 160;
const MAX_FILTERS = 16;
const MAX_FILTER_PATH_CHARS = 160;
// ReDoS stance for webhook `matches` filters: the pattern is length-capped here
// and compile-guarded at creation (below), and compiled patterns are re-tested
// per event inside a try/catch. A safe-regex analyzer or RE2 is deliberately not
// used — these filters are operator-authored and approval-gated, and a tight
// length cap plus a compile guard is a proportionate mitigation for the blast
// radius (one gateway-local trigger burning CPU on its own inbound events).
const MAX_FILTER_REGEX_CHARS = 256;
// Fail-closed input cap for a `matches` test. This is NOT a backtracking defense
// (the worker timeout is) — it just bounds serialization/copy cost into the
// worker. An input longer than this fails closed (non-match); it is NEVER
// truncated-then-matched, which would change semantics on anchored patterns.
const MAX_FILTER_MATCH_INPUT_CHARS = 4096;

/**
 * UX-only fast feedback (NOT the security boundary — that is the match-time
 * worker timeout in regex-eval.ts). Rejects the obvious exponential foot-gun at
 * creation so the author sees an immediate error instead of a filter that later
 * silently fails closed. It flags star-height > 1 — a quantified group whose body
 * itself varies (contains a quantifier or an alternation), e.g. `(a+)+`, `(a*)*`,
 * `(a|aa)+`, `([a-z]+)+`, `((a+))+`. It deliberately does NOT catch polynomial
 * blowups like `^a*a*a*a*$` (no static detector reliably does); the worker
 * timeout is what actually bounds those. Over-rejects exotic-but-safe nesting —
 * trigger filters do not need it. A hand-written single-pass scanner (no deps):
 * tracks group frames, marks a frame "variable" when its body has a quantifier or
 * `|`, and flags DANGER when a variable group is immediately quantified; that
 * variability propagates to the enclosing group so deep nesting is caught too.
 * Escapes and character classes are skipped so `\(`, `[a+]`, `[)]` are literal.
 */
export function hasCatastrophicRegexNesting(pattern: string): boolean {
  interface Frame { variable: boolean }
  const stack: Frame[] = [];
  const isQuant = (ch: string | undefined): boolean =>
    ch === '*' || ch === '+' || ch === '?' || ch === '{';
  const n = pattern.length;
  let i = 0;
  while (i < n) {
    const ch = pattern[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') {
      // Skip the character class — quantifier chars inside are literal.
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++; // a leading ] is a literal member
      while (i < n && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++;
        i++;
      }
      i++; // consume the closing ]
      continue;
    }
    if (ch === '(') {
      i++;
      // Skip a group-type prefix so the '?' in (?: (?= (?! (?<= (?<! (?<name>
      // is not mistaken for a quantifier.
      if (pattern[i] === '?') {
        i++;
        if (pattern[i] === '<') {
          i++;
          if (pattern[i] === '=' || pattern[i] === '!') i++;
          else { while (i < n && pattern[i] !== '>') i++; i++; }
        } else if (pattern[i] === ':' || pattern[i] === '=' || pattern[i] === '!') {
          i++;
        }
      }
      stack.push({ variable: false });
      continue;
    }
    if (ch === ')') {
      const frame = stack.pop();
      i++;
      const nextIsQuant = isQuant(pattern[i]);
      const bodyVariable = !!frame && frame.variable;
      if (bodyVariable && nextIsQuant) return true; // variable group, quantified → ReDoS shape
      // A group that is itself variable or quantified makes the ENCLOSING body
      // variable, so `((a+))+` and friends are caught one level out.
      if (stack.length && (bodyVariable || nextIsQuant)) stack[stack.length - 1].variable = true;
      continue;
    }
    if (isQuant(ch)) {
      if (stack.length) stack[stack.length - 1].variable = true;
      if (ch === '{') { while (i < n && pattern[i] !== '}') i++; }
      i++;
      continue;
    }
    if (ch === '|') {
      if (stack.length) stack[stack.length - 1].variable = true;
      i++;
      continue;
    }
    i++;
  }
  return false;
}
const MAX_PAYLOAD_DEPTH = 8;
const MAX_PAYLOAD_KEYS = 200;
const MAX_PAYLOAD_ARRAY = 100;
const MAX_PAYLOAD_STRING_CHARS = 8000;
export const POLL_DEFAULT_TIMEOUT_MS = 30_000;
export const POLL_DEFAULT_STDOUT_MAX_BYTES = 64 * 1024;
export const POLL_DEFAULT_STDERR_MAX_BYTES = 16 * 1024;
export const POLL_CWD_POLICY = 'jinn-home-or-process-cwd';
// Poll commands run with a SCRUBBED inherited environment (allowlist only), so
// secret environment variables are not handed to the child. This is not a
// filesystem/network sandbox: the artifact manifest below prevents silent code
// replacement, while least-privilege process isolation remains follow-up work.
// The exact allowlist is baked into POLL_ENV_POLICY so changing it rehashes the
// activation contract and forces re-approval.
export const POLL_ENV_ALLOWLIST = ['PATH', 'HOME', 'JINN_HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;
export const POLL_ENV_POLICY = `scrubbed-allowlist:${POLL_ENV_ALLOWLIST.join(',')}`;

export type WorkflowTriggerKind = 'webhook' | 'poll';
export type WorkflowTriggerActivation = 'active' | 'pending_approval' | 'disabled';
export type WorkflowTriggerFilterOp = 'equals' | 'notEquals' | 'exists' | 'matches';

export interface WorkflowTriggerFilter {
  path: string;
  op: WorkflowTriggerFilterOp;
  value?: unknown;
}

export interface WorkflowTriggerBindingBase {
  schemaVersion: number;
  kind: WorkflowTriggerKind;
  name: string;
  event: string;
  targetWorkflowId: string;
  sopOwnerWorkflowId?: string;
  filter?: WorkflowTriggerFilter[];
  activation: WorkflowTriggerActivation;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  /** Immutable identity for one authored binding revision; operational stamps do not change it. */
  bindingRevision?: string;
}

export interface WebhookWorkflowTriggerBinding extends WorkflowTriggerBindingBase {
  kind: 'webhook';
  source: 'event-webhook';
  secretTokenHash?: string;
  secretTokenPreview?: string;
}

export interface PollWorkflowTriggerBinding extends WorkflowTriggerBindingBase {
  kind: 'poll';
  source: 'poll';
  command: string;
  intervalSeconds: number;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
  approvalWorkItemId?: string;
  activationContract?: PollWorkflowActivationContract;
  activationContractHash?: string;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  lastOutcome?: string;
}

export interface PollWorkflowActivationContract {
  command: string;
  intervalSeconds: number;
  cwdPolicy: typeof POLL_CWD_POLICY;
  envPolicy: typeof POLL_ENV_POLICY;
  timeoutMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  executableArtifacts: PollExecutableArtifact[];
}

export type WorkflowTriggerBinding = WebhookWorkflowTriggerBinding | PollWorkflowTriggerBinding;

export type PublicWorkflowTriggerBinding =
  | Omit<WebhookWorkflowTriggerBinding, 'secretTokenHash'>
  | PollWorkflowTriggerBinding;

export interface CreateWorkflowTriggerBindingInput {
  kind: WorkflowTriggerKind;
  name: string;
  event: string;
  targetWorkflowId: string;
  filter?: WorkflowTriggerFilter[];
  secretToken?: string;
  command?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
  approvalWorkItemId?: string;
  activation?: WorkflowTriggerActivation;
  createdBy?: string;
  sopOwnerWorkflowId?: string;
}

export interface CreateWorkflowTriggerBindingResult {
  binding: WorkflowTriggerBinding;
  /** Returned only when the store generated a webhook token for this create call. */
  secretToken?: string;
}

export type CreateWebhookWorkflowTriggerBindingInput =
  CreateWorkflowTriggerBindingInput & { kind: 'webhook' };

export type CreatePollWorkflowTriggerBindingInput =
  CreateWorkflowTriggerBindingInput & { kind: 'poll'; command: string; intervalSeconds: number };

export interface CreateWebhookWorkflowTriggerBindingResult extends CreateWorkflowTriggerBindingResult {
  binding: WebhookWorkflowTriggerBinding;
}

export interface CreatePollWorkflowTriggerBindingResult extends CreateWorkflowTriggerBindingResult {
  binding: PollWorkflowTriggerBinding;
}

export type FireWorkflowEventRejected =
  | 'bad-event'
  | 'bad-payload'
  | 'no-matching-binding';

export type FireWorkflowEventOutcome =
  | { triggerName: string; outcome: 'started'; run: WorkflowRun }
  | { triggerName: string; outcome: 'missing-workflow'; targetWorkflowId: string };

export interface FireWorkflowEventResult {
  outcomes: FireWorkflowEventOutcome[];
  rejected?: FireWorkflowEventRejected;
}

export interface FireWorkflowEventInput {
  event: string;
  payload: Record<string, unknown>;
  fireRef?: string;
}

export interface FireWorkflowEventOptions {
  gatewayAuthorized?: boolean;
  authorizedSecretToken?: string;
  knownEmployees?: Iterable<string>;
  knownEngines?: Iterable<string>;
}

export type WorkflowTriggerStoreErrorCode =
  | 'invalid-input'
  | 'invalid-name'
  | 'conflict'
  | 'not-found';

export class WorkflowTriggerStoreError extends Error {
  readonly code: WorkflowTriggerStoreErrorCode;
  constructor(code: WorkflowTriggerStoreErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowTriggerStoreError';
    this.code = code;
  }
}

interface StoredWorkflowTriggerBindings {
  schemaVersion: number;
  triggers: WorkflowTriggerBinding[];
}

interface WorkflowEventRateLimitConfig {
  max: number;
  windowMs: number;
  now: () => number;
}

let rateLimitConfig: WorkflowEventRateLimitConfig = {
  max: 60,
  windowMs: 60_000,
  now: () => Date.now(),
};
const rateLimitBuckets = new Map<string, { windowStart: number; count: number }>();

function defaultNow(): string {
  return new Date().toISOString();
}

function triggerStoreFile(root: string): string {
  return path.join(root, TRIGGER_DIR, TRIGGER_FILE);
}

function assertSafeName(name: unknown, label: string): asserts name is string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new WorkflowTriggerStoreError('invalid-name', `${label} is required`);
  }
  if (name.length > MAX_NAME_CHARS) {
    throw new WorkflowTriggerStoreError('invalid-name', `${label} is too long (max ${MAX_NAME_CHARS})`);
  }
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.includes('..') ||
    name === '.' ||
    name === '..' ||
    !SAFE_NAME.test(name)
  ) {
    throw new WorkflowTriggerStoreError('invalid-name', `${label} must match ${SAFE_NAME.source}`);
  }
}

function cleanEvent(event: unknown): string {
  if (typeof event !== 'string') {
    throw new WorkflowTriggerStoreError('invalid-input', 'event is required');
  }
  const trimmed = event.trim();
  if (!trimmed) throw new WorkflowTriggerStoreError('invalid-input', 'event is required');
  if (trimmed.length > MAX_EVENT_CHARS) {
    throw new WorkflowTriggerStoreError('invalid-input', `event is too long (max ${MAX_EVENT_CHARS})`);
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new WorkflowTriggerStoreError('invalid-input', 'event must not contain control characters');
  }
  return trimmed;
}

function cleanPositiveInt(value: unknown, label: string, opts: { min?: number; max?: number; fallback?: number } = {}): number {
  if (value === undefined || value === null) {
    if (opts.fallback !== undefined) return opts.fallback;
    throw new WorkflowTriggerStoreError('invalid-input', `${label} is required`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new WorkflowTriggerStoreError('invalid-input', `${label} must be an integer`);
  }
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) {
    throw new WorkflowTriggerStoreError('invalid-input', `${label} must be between ${min} and ${max}`);
  }
  return value;
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('base64url');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function bindingSemanticValue(binding: WorkflowTriggerBinding): Record<string, unknown> {
  const value = { ...binding } as Record<string, unknown>;
  delete value.bindingRevision;
  delete value.createdAt;
  delete value.updatedAt;
  if (binding.kind === 'poll') {
    delete value.lastCheckedAt;
    delete value.lastFiredAt;
    delete value.lastOutcome;
  }
  return value;
}

export function workflowTriggerBindingRevision(binding: WorkflowTriggerBinding): string {
  return binding.bindingRevision
    ?? `legacy-${crypto.createHash('sha256').update(stableJson(bindingSemanticValue(binding))).digest('hex')}`;
}

function pollExecutionCwd(): string {
  return process.env.JINN_HOME || process.cwd();
}

function pollActivationPolicy(binding: Pick<PollWorkflowTriggerBinding, 'command' | 'intervalSeconds' | 'timeoutMs' | 'stdoutMaxBytes' | 'stderrMaxBytes'>): Omit<PollWorkflowActivationContract, 'executableArtifacts'> {
  return {
    command: binding.command,
    intervalSeconds: binding.intervalSeconds,
    cwdPolicy: POLL_CWD_POLICY,
    envPolicy: POLL_ENV_POLICY,
    timeoutMs: binding.timeoutMs ?? POLL_DEFAULT_TIMEOUT_MS,
    stdoutMaxBytes: binding.stdoutMaxBytes ?? POLL_DEFAULT_STDOUT_MAX_BYTES,
    stderrMaxBytes: binding.stderrMaxBytes ?? POLL_DEFAULT_STDERR_MAX_BYTES,
  };
}

export function pollActivationContract(binding: Pick<PollWorkflowTriggerBinding, 'command' | 'intervalSeconds' | 'timeoutMs' | 'stdoutMaxBytes' | 'stderrMaxBytes'>): PollWorkflowActivationContract {
  return {
    ...pollActivationPolicy(binding),
    executableArtifacts: snapshotPollExecutableArtifacts(binding.command, {
      cwd: pollExecutionCwd(),
      env: process.env,
    }),
  };
}

export function pollActivationContractHash(binding: Pick<PollWorkflowTriggerBinding, 'command' | 'intervalSeconds' | 'timeoutMs' | 'stdoutMaxBytes' | 'stderrMaxBytes'>): string {
  return crypto.createHash('sha256').update(stableJson(pollActivationContract(binding))).digest('hex');
}

export function withPollActivationContract(binding: PollWorkflowTriggerBinding): PollWorkflowTriggerBinding {
  const activationContract = pollActivationContract(binding);
  return {
    ...binding,
    activationContract,
    activationContractHash: crypto.createHash('sha256').update(stableJson(activationContract)).digest('hex'),
  };
}

export function pollActivationContractMatches(binding: PollWorkflowTriggerBinding): boolean {
  try {
    return !!binding.activationContractHash
      && !!binding.activationContract?.executableArtifacts?.length
      && binding.activationContractHash === pollActivationContractHash(binding);
  } catch {
    return false;
  }
}

export function formatPollActivationApprovalRequest(binding: PollWorkflowTriggerBinding): string {
  const contract = binding.activationContract ?? pollActivationContract(binding);
  const hash = binding.activationContractHash
    ?? crypto.createHash('sha256').update(stableJson(contract)).digest('hex');
  return [
    `Activate poll trigger "${binding.name}" for workflow "${binding.targetWorkflowId}".`,
    '',
    'Execution contract:',
    `command: ${contract.command}`,
    `intervalSeconds: ${contract.intervalSeconds}`,
    `cwdPolicy: ${contract.cwdPolicy}`,
    `envPolicy: ${contract.envPolicy}`,
    `timeoutMs: ${contract.timeoutMs}`,
    `stdoutMaxBytes: ${contract.stdoutMaxBytes}`,
    `stderrMaxBytes: ${contract.stderrMaxBytes}`,
    ...contract.executableArtifacts.map((artifact) =>
      `artifact: ${artifact.role} ${artifact.path} sha256:${artifact.sha256}`),
    `activationContractHash: ${hash}`,
  ].join('\n');
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function tokenPreview(secret: string): string {
  return secret.length <= 8 ? 'configured' : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

function readStore(root: string): StoredWorkflowTriggerBindings {
  const file = triggerStoreFile(root);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: TRIGGER_STORE_SCHEMA_VERSION, triggers: [] };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as StoredWorkflowTriggerBindings;
    return {
      schemaVersion: TRIGGER_STORE_SCHEMA_VERSION,
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers : [],
    };
  } catch (err) {
    throw new WorkflowTriggerStoreError('invalid-input', `workflow trigger store is not valid JSON: ${(err as Error).message}`);
  }
}

function saveStore(root: string, store: StoredWorkflowTriggerBindings): void {
  const sorted = [...store.triggers].sort((a, b) => a.name.localeCompare(b.name));
  writeAtomic(triggerStoreFile(root), JSON.stringify({ schemaVersion: TRIGGER_STORE_SCHEMA_VERSION, triggers: sorted }, null, 2));
}

function cleanTargetWorkflowId(targetWorkflowId: unknown): string {
  assertSafeName(targetWorkflowId, 'targetWorkflowId');
  return targetWorkflowId;
}

function cleanFilter(input: unknown): WorkflowTriggerFilter[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) {
    throw new WorkflowTriggerStoreError('invalid-input', 'filter must be an array');
  }
  if (input.length > MAX_FILTERS) {
    throw new WorkflowTriggerStoreError('invalid-input', `filter has too many entries (max ${MAX_FILTERS})`);
  }
  const out: WorkflowTriggerFilter[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new WorkflowTriggerStoreError('invalid-input', 'filter entries must be JSON objects');
    }
    const rec = entry as Record<string, unknown>;
    const pathValue = typeof rec.path === 'string' ? rec.path.trim() : '';
    if (!pathValue || pathValue.length > MAX_FILTER_PATH_CHARS) {
      throw new WorkflowTriggerStoreError('invalid-input', `filter.path is required and must be <= ${MAX_FILTER_PATH_CHARS} chars`);
    }
    if (!/^(payload|event|fireRef)(\.[A-Za-z0-9_-]+)*$/.test(pathValue)) {
      throw new WorkflowTriggerStoreError('invalid-input', 'filter.path must start with payload, event, or fireRef and use safe segments');
    }
    const op = rec.op;
    if (op !== 'equals' && op !== 'notEquals' && op !== 'exists' && op !== 'matches') {
      throw new WorkflowTriggerStoreError('invalid-input', 'filter.op must be equals, notEquals, exists, or matches');
    }
    if (op === 'matches') {
      if (typeof rec.value !== 'string') {
        throw new WorkflowTriggerStoreError('invalid-input', 'filter.value must be a string for matches');
      }
      if (rec.value.length > MAX_FILTER_REGEX_CHARS) {
        throw new WorkflowTriggerStoreError('invalid-input', `filter.value regex must be <= ${MAX_FILTER_REGEX_CHARS} chars`);
      }
      // Compile-guard at creation so an invalid pattern is rejected up front
      // rather than silently never-matching at event time.
      try {
        new RegExp(rec.value);
      } catch {
        throw new WorkflowTriggerStoreError('invalid-input', 'filter.value is not a valid regular expression');
      }
      // Reject the obvious exponential foot-gun at creation for fast author
      // feedback. This is UX, not the security boundary — the match-time worker
      // timeout (regex-eval.ts) is what actually contains a bad pattern (incl. the
      // polynomial ones this detector cannot catch, and any that bypass creation).
      if (hasCatastrophicRegexNesting(rec.value)) {
        throw new WorkflowTriggerStoreError(
          'invalid-input',
          'filter.value has nested quantifiers that risk catastrophic backtracking (ReDoS) — simplify the regex',
        );
      }
    }
    out.push({ path: pathValue, op, ...(rec.value !== undefined ? { value: sanitizeJsonValue(rec.value) } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    return cleaned.length > MAX_PAYLOAD_STRING_CHARS ? cleaned.slice(0, MAX_PAYLOAD_STRING_CHARS) : cleaned;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_PAYLOAD_DEPTH) return [];
    return value.slice(0, MAX_PAYLOAD_ARRAY).map((v) => sanitizeJsonValue(v, depth + 1));
  }
  if (isPlainObject(value)) {
    if (depth >= MAX_PAYLOAD_DEPTH) return {};
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, child] of Object.entries(value)) {
      if (count >= MAX_PAYLOAD_KEYS) break;
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
      const cleanKey = key.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
      if (!cleanKey) continue;
      out[cleanKey] = sanitizeJsonValue(child, depth + 1);
      count++;
    }
    return out;
  }
  return null;
}

export function sanitizeWorkflowTriggerPayload(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw new WorkflowTriggerStoreError('invalid-input', 'payload must be a JSON object');
  }
  return sanitizeJsonValue(payload) as Record<string, unknown>;
}

function publicActivation(binding: WorkflowTriggerBinding): WorkflowTriggerActivation {
  if (binding.kind !== 'poll' || binding.activation === 'disabled') return binding.activation;
  if (!binding.approvalWorkItemId) return 'pending_approval';
  if (!pollActivationContractMatches(binding)) return 'pending_approval';
  const item = getWorkItem(binding.approvalWorkItemId);
  return item?.approvalState === 'approved' ? 'active' : 'pending_approval';
}

export function publicWorkflowTriggerBinding(binding: WorkflowTriggerBinding): PublicWorkflowTriggerBinding {
  if (binding.kind === 'webhook') {
    const { secretTokenHash: _secretTokenHash, ...rest } = binding;
    return rest;
  }
  return { ...binding, activation: publicActivation(binding) };
}

export function listWorkflowTriggerBindings(root: string): WorkflowTriggerBinding[] {
  return readStore(root).triggers;
}

export function listPublicWorkflowTriggerBindings(root: string): PublicWorkflowTriggerBinding[] {
  return listWorkflowTriggerBindings(root).map(publicWorkflowTriggerBinding);
}

export function getWorkflowTriggerBinding(root: string, name: string): WorkflowTriggerBinding | null {
  assertSafeName(name, 'name');
  return readStore(root).triggers.find((t) => t.name === name) ?? null;
}

export function createWorkflowTriggerBinding(
  root: string,
  input: CreateWebhookWorkflowTriggerBindingInput,
  opts?: { now?: () => string },
): CreateWebhookWorkflowTriggerBindingResult;
export function createWorkflowTriggerBinding(
  root: string,
  input: CreatePollWorkflowTriggerBindingInput,
  opts?: { now?: () => string },
): CreatePollWorkflowTriggerBindingResult;
export function createWorkflowTriggerBinding(
  root: string,
  input: CreateWorkflowTriggerBindingInput,
  opts?: { now?: () => string },
): CreateWorkflowTriggerBindingResult;
export function createWorkflowTriggerBinding(
  root: string,
  input: CreateWorkflowTriggerBindingInput,
  opts: { now?: () => string } = {},
): CreateWorkflowTriggerBindingResult {
  if (!input || typeof input !== 'object') {
    throw new WorkflowTriggerStoreError('invalid-input', 'trigger body is required');
  }
  assertSafeName(input.name, 'name');
  const event = cleanEvent(input.event);
  const targetWorkflowId = cleanTargetWorkflowId(input.targetWorkflowId);
  const store = readStore(root);
  if (store.triggers.some((t) => t.name === input.name)) {
    throw new WorkflowTriggerStoreError('conflict', `workflow trigger "${input.name}" already exists`);
  }
  const now = (opts.now ?? defaultNow)();
  const base = {
    schemaVersion: TRIGGER_STORE_SCHEMA_VERSION,
    name: input.name,
    event,
    targetWorkflowId,
    ...(typeof input.sopOwnerWorkflowId === 'string' && input.sopOwnerWorkflowId.trim()
      ? { sopOwnerWorkflowId: cleanTargetWorkflowId(input.sopOwnerWorkflowId) }
      : {}),
    ...(cleanFilter(input.filter) ? { filter: cleanFilter(input.filter) } : {}),
    createdAt: now,
    updatedAt: now,
    bindingRevision: randomUUID(),
    ...(typeof input.createdBy === 'string' && input.createdBy.trim() ? { createdBy: input.createdBy.trim() } : {}),
  };
  let generatedSecret: string | undefined;
  let binding: WorkflowTriggerBinding;
  if (input.kind === 'webhook') {
    const provided = typeof input.secretToken === 'string' && input.secretToken.trim() ? input.secretToken.trim() : undefined;
    const secret = provided ?? `jinn_wh_${crypto.randomBytes(24).toString('base64url')}`;
    if (!provided) generatedSecret = secret;
    binding = {
      ...base,
      kind: 'webhook',
      source: 'event-webhook',
      activation: input.activation ?? 'active',
      secretTokenHash: hashSecret(secret),
      secretTokenPreview: tokenPreview(secret),
    };
  } else if (input.kind === 'poll') {
    if (typeof input.command !== 'string' || !input.command.trim()) {
      throw new WorkflowTriggerStoreError('invalid-input', 'command is required for poll triggers');
    }
    binding = {
      ...base,
      kind: 'poll',
      source: 'poll',
      activation: input.activation ?? 'pending_approval',
      command: input.command,
      intervalSeconds: cleanPositiveInt(input.intervalSeconds, 'intervalSeconds', { min: 1, max: 86_400 }),
      ...(input.timeoutMs !== undefined ? { timeoutMs: cleanPositiveInt(input.timeoutMs, 'timeoutMs', { min: 10, max: 300_000 }) } : {}),
      ...(input.stdoutMaxBytes !== undefined ? { stdoutMaxBytes: cleanPositiveInt(input.stdoutMaxBytes, 'stdoutMaxBytes', { min: 1, max: 1024 * 1024 }) } : {}),
      ...(input.stderrMaxBytes !== undefined ? { stderrMaxBytes: cleanPositiveInt(input.stderrMaxBytes, 'stderrMaxBytes', { min: 1, max: 1024 * 1024 }) } : {}),
      ...(typeof input.approvalWorkItemId === 'string' && input.approvalWorkItemId.trim()
        ? { approvalWorkItemId: input.approvalWorkItemId.trim() }
        : {}),
    };
    if (binding.approvalWorkItemId) {
      binding = withPollActivationContract(binding);
    }
  } else {
    throw new WorkflowTriggerStoreError('invalid-input', 'kind must be webhook or poll');
  }
  store.triggers.push(binding);
  saveStore(root, store);
  return { binding, ...(generatedSecret ? { secretToken: generatedSecret } : {}) };
}

export async function deleteWorkflowTriggerBinding(root: string, name: string): Promise<boolean> {
  assertSafeName(name, 'name');
  const store = readStore(root);
  const next = store.triggers.filter((t) => t.name !== name);
  if (next.length === store.triggers.length) return false;
  saveStore(root, { ...store, triggers: next });
  await abortPollExecutions(root, name);
  return true;
}

export async function updateWorkflowTriggerBinding(root: string, binding: WorkflowTriggerBinding): Promise<WorkflowTriggerBinding> {
  const store = readStore(root);
  const idx = store.triggers.findIndex((t) => t.name === binding.name);
  if (idx < 0) throw new WorkflowTriggerStoreError('not-found', `workflow trigger "${binding.name}" not found`);
  const previous = store.triggers[idx];
  let updated = { ...binding, updatedAt: defaultNow() } as WorkflowTriggerBinding;
  if (previous.kind === 'poll' && updated.kind === 'poll') {
    const contractChanged = stableJson(pollActivationPolicy(previous)) !== stableJson(pollActivationPolicy(updated));
    if (contractChanged) {
      const {
        approvalWorkItemId: _approvalWorkItemId,
        activationContract: _activationContract,
        activationContractHash: _activationContractHash,
        ...rest
      } = updated;
      updated = {
        ...rest,
        activation: updated.activation === 'disabled' ? 'disabled' : 'pending_approval',
      } as PollWorkflowTriggerBinding;
    }
  }
  const previousRevision = workflowTriggerBindingRevision(previous);
  if (stableJson(bindingSemanticValue(previous)) !== stableJson(bindingSemanticValue(updated))) {
    updated = { ...updated, bindingRevision: randomUUID() };
  } else {
    updated = { ...updated, bindingRevision: previousRevision };
  }
  store.triggers[idx] = updated;
  saveStore(root, store);
  if (workflowTriggerBindingRevision(updated) !== previousRevision) {
    await abortPollExecutions(root, updated.name, previousRevision);
  }
  return updated;
}

export function verifyWorkflowTriggerBindingToken(binding: WorkflowTriggerBinding, token: string | undefined): boolean {
  if (binding.kind !== 'webhook' || !binding.secretTokenHash || typeof token !== 'string' || !token) return false;
  return safeEqual(hashSecret(token), binding.secretTokenHash);
}

export function verifyAnyWorkflowTriggerBindingToken(root: string, token: string | undefined): boolean {
  if (typeof token !== 'string' || !token) return false;
  return listWorkflowTriggerBindings(root).some((binding) => verifyWorkflowTriggerBindingToken(binding, token));
}

function readFilterPath(input: FireWorkflowEventInput, pathValue: string): unknown {
  const parts = pathValue.split('.');
  let current: unknown = parts[0] === 'payload' ? input.payload : parts[0] === 'event' ? input.event : input.fireRef;
  for (const part of parts.slice(1)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function filterMatches(
  input: FireWorkflowEventInput,
  filter: WorkflowTriggerFilter,
  label?: string,
): Promise<boolean> {
  const actual = readFilterPath(input, filter.path);
  switch (filter.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return JSON.stringify(actual) === JSON.stringify(filter.value);
    case 'notEquals':
      return JSON.stringify(actual) !== JSON.stringify(filter.value);
    case 'matches': {
      if (typeof actual !== 'string' || typeof filter.value !== 'string') return false;
      // Fail CLOSED on oversize input — never truncate-then-match (that would
      // flip an anchored pattern like `^…$` to a false positive on the prefix).
      if (actual.length > MAX_FILTER_MATCH_INPUT_CHARS) {
        logger.warn(
          `[workflow-triggers] regex filter input exceeded ${MAX_FILTER_MATCH_INPUT_CHARS} chars — failing closed (non-match)${label ? ` (trigger "${label}")` : ''}`,
        );
        return false;
      }
      // The actual security boundary: run the operator-authored regex in an
      // isolated worker with a hard wall-clock timeout; timeout/error → non-match.
      return evaluateRegexMatch(filter.value, actual, { label });
    }
  }
}

async function bindingMatchesEvent(binding: WorkflowTriggerBinding, input: FireWorkflowEventInput): Promise<boolean> {
  if (binding.kind !== 'webhook') return false;
  if (binding.activation !== 'active') return false;
  if (binding.event !== input.event) return false;
  for (const f of binding.filter ?? []) {
    if (!(await filterMatches(input, f, binding.name))) return false;
  }
  return true;
}

export async function fireWorkflowEvent(
  deps: RunDriverDeps,
  input: FireWorkflowEventInput,
  opts: FireWorkflowEventOptions = {},
): Promise<FireWorkflowEventResult> {
  let event: string;
  let payload: Record<string, unknown>;
  try {
    event = cleanEvent(input.event);
    payload = sanitizeWorkflowTriggerPayload(input.payload);
  } catch (err) {
    if (err instanceof WorkflowTriggerStoreError && err.message.includes('payload')) {
      return { rejected: 'bad-payload', outcomes: [] };
    }
    return { rejected: 'bad-event', outcomes: [] };
  }
  const fireInput: FireWorkflowEventInput = {
    event,
    payload,
    ...(typeof input.fireRef === 'string' && input.fireRef.trim() ? { fireRef: input.fireRef.trim().slice(0, 256) } : {}),
  };
  const tokenAuthorized = (binding: WorkflowTriggerBinding): boolean => {
    if (opts.gatewayAuthorized !== false && opts.authorizedSecretToken === undefined) return true;
    if (opts.gatewayAuthorized === true) return true;
    return verifyWorkflowTriggerBindingToken(binding, opts.authorizedSecretToken);
  };
  // Filter eval is async (regexes run in an isolated worker), so select
  // sequentially rather than via Array.filter. Cheap gates (kind/activation/event/
  // token) short-circuit before any worker round-trip.
  const candidates: Array<{
    binding: WorkflowTriggerBinding;
    definitionState: ReturnType<typeof resolveActiveTriggerDefinition>;
  }> = [];
  for (const binding of listWorkflowTriggerBindings(deps.root)) {
    if (!tokenAuthorized(binding)) continue;
    if (!(await bindingMatchesEvent(binding, fireInput))) continue;
    const latest = getWorkflowTriggerBinding(deps.root, binding.name);
    if (!latest || workflowTriggerBindingRevision(latest) !== workflowTriggerBindingRevision(binding)) continue;
    if (!tokenAuthorized(latest)) continue;
    const definitionState = resolveActiveTriggerDefinition(deps, latest.targetWorkflowId);
    if (definitionState.state === 'inactive') continue;
    candidates.push({ binding: latest, definitionState });
  }
  if (candidates.length === 0) return { rejected: 'no-matching-binding', outcomes: [] };

  const outcomes: FireWorkflowEventOutcome[] = [];
  for (const candidate of candidates) {
    const { binding } = candidate;
    const latest = getWorkflowTriggerBinding(deps.root, binding.name);
    if (!latest || workflowTriggerBindingRevision(latest) !== workflowTriggerBindingRevision(binding)) continue;
    if (!tokenAuthorized(latest)) continue;
    const definitionState = resolveActiveTriggerDefinition(deps, latest.targetWorkflowId);
    if (definitionState.state === 'inactive') continue;
    if (definitionState.state === 'missing') {
      outcomes.push({ triggerName: binding.name, outcome: 'missing-workflow', targetWorkflowId: binding.targetWorkflowId });
      continue;
    }
    const trigger: WorkflowTriggerEvent = {
      source: 'event-webhook',
      event,
      payload,
      ...(fireInput.fireRef ? { fireRef: fireInput.fireRef } : {}),
    };
    const run = await startWorkflowRunFromTrigger(deps, definitionState.definition, trigger, {
      ...(opts.knownEmployees ? { knownEmployees: opts.knownEmployees } : {}),
      ...(opts.knownEngines ? { knownEngines: opts.knownEngines } : {}),
    });
    outcomes.push({ triggerName: binding.name, outcome: 'started', run });
  }
  return outcomes.length > 0 ? { outcomes } : { rejected: 'no-matching-binding', outcomes: [] };
}

export function workflowEventRateLimitKeyFromToken(prefix: string, token: string): string {
  return `${prefix}:${hashSecret(token)}`;
}

export function checkWorkflowEventRateLimit(key: string): { ok: true } | { ok: false; resetAt: number } {
  const now = rateLimitConfig.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= rateLimitConfig.windowMs) {
    rateLimitBuckets.set(key, { windowStart: now, count: 1 });
    return { ok: true };
  }
  if (bucket.count >= rateLimitConfig.max) {
    return { ok: false, resetAt: bucket.windowStart + rateLimitConfig.windowMs };
  }
  bucket.count++;
  return { ok: true };
}

export function configureWorkflowEventRateLimitForTests(config: Partial<WorkflowEventRateLimitConfig>): void {
  rateLimitConfig = { ...rateLimitConfig, ...config };
  rateLimitBuckets.clear();
}

export function resetWorkflowEventRateLimitForTests(): void {
  rateLimitConfig = {
    max: 60,
    windowMs: 60_000,
    now: () => Date.now(),
  };
  rateLimitBuckets.clear();
}
