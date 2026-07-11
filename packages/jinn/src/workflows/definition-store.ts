import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MAX_WORKFLOW_NAME_LENGTH,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  WORKFLOW_NAME_PATTERN,
  serializeDefinition,
  validateDefinition,
  type EditableWorkflowDefinition,
  type ValidationError,
} from './definition.js';
import {
  prepareWorkflowLayoutForWrite,
  WorkflowLayoutError,
  type WorkflowLayoutIntent,
} from './layout.js';

/**
 * File-backed CRUD store for editable workflow definitions (GRS-011b).
 *
 * This is the FIRST LIVE CONSUMER of the GRS-011a schema — it list/get/create/
 * update/duplicate/retire definitions on disk at:
 *
 *     <evidenceRoot>/workflows/<id>.definition.json
 *
 * Storage contract (GRS-011a §"Storage decision"): file-backed JSON, one file per
 * definition, single-file + integer `version`, history via git. No DB, no
 * run/attempt store. Editing a definition NEVER touches the read-only run receipts
 * that `derive.ts` reads (`<id>.workflow.yaml` + `reports/waves/*.json`) — Edit view
 * and Run view are distinct artifacts.
 *
 * Every mutating call validates the RESULT with `validateDefinition` before writing,
 * so a schema-invalid graph can never reach disk (an editor save is rejected with the
 * full error list, not silently persisted). Writes are atomic (temp file + rename).
 *
 * The module is pure fs (no gateway/env coupling) and takes an injectable clock so it
 * is deterministically testable and reusable by the gateway routes (this slice) and
 * the canvas (GRS-011c).
 */

const DEFINITION_SUFFIX = '.definition.json';

/** Compact list-view row. Full graphs are only returned by `getDefinition`. */
export interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  title: string;
  status: EditableWorkflowDefinition['status'];
  version: number;
  updatedAt?: string;
  nodeCount: number;
  edgeCount: number;
}

export type WorkflowStoreErrorCode =
  | 'invalid-id'
  | 'invalid-name'
  | 'bad-input'
  | 'validation'
  | 'not-found'
  | 'conflict';

/**
 * Typed store failure. The gateway maps `.code` to an HTTP status:
 * invalid-id/bad-input → 400, validation → 400 (+`errors`), not-found → 404,
 * conflict → 409.
 */
export class WorkflowStoreError extends Error {
  readonly code: WorkflowStoreErrorCode;
  readonly errors?: ValidationError[];
  constructor(code: WorkflowStoreErrorCode, message: string, errors?: ValidationError[]) {
    super(message);
    this.name = 'WorkflowStoreError';
    this.code = code;
    if (errors) this.errors = errors;
  }
}

export interface WriteOptions {
  /** Injectable clock for deterministic tests; defaults to real wall-clock ISO. */
  now?: () => string;
  /** Server-controlled coordinate policy. Metadata on the definition is not consulted. */
  layoutIntent?: WorkflowLayoutIntent;
}

export interface UpdateOptions extends WriteOptions {
  /** Optimistic-lock guard for the editor's save: if set and != on-disk version → conflict. */
  expectedVersion?: number;
}

export interface DuplicateOptions extends WriteOptions {
  /** Explicit id for the copy; if taken → conflict. Omitted → `<id>-copy` (auto-disambiguated). */
  newId?: string;
  /** Explicit title for the copy; omitted → `<title> (copy)`. */
  title?: string;
  /** Server-owned metadata patch applied while creating the copy. */
  definitionPatch?: Partial<EditableWorkflowDefinition> & Record<string, unknown>;
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * A workflow id must be a single safe filename segment (it is interpolated into a
 * path). matchRoute already guards the HTTP `:id` param, but the store is also called
 * directly (tests, CRUD import), so re-guard here — defense in depth.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertSafeId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id.trim()) {
    throw new WorkflowStoreError('invalid-id', 'workflow id is required');
  }
  if (id.length > 128) {
    throw new WorkflowStoreError('invalid-id', 'workflow id is too long (max 128)');
  }
  if (
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('\0') ||
    id.includes('..') ||
    id === '.' ||
    id === '..'
  ) {
    throw new WorkflowStoreError('invalid-id', `unsafe workflow id "${id}"`);
  }
  if (!SAFE_ID.test(id)) {
    throw new WorkflowStoreError('invalid-id', `workflow id must match ${SAFE_ID.source}`);
  }
}

function assertValidName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_WORKFLOW_NAME_LENGTH ||
    !WORKFLOW_NAME_PATTERN.test(name)
  ) {
    throw new WorkflowStoreError(
      'invalid-name',
      `workflow name must be kebab-case, match ${WORKFLOW_NAME_PATTERN.source}, and be at most ${MAX_WORKFLOW_NAME_LENGTH} characters`,
    );
  }
}

function definitionsDir(root: string): string {
  return path.join(root, 'workflows');
}

function definitionFile(root: string, id: string): string {
  assertSafeId(id);
  return path.join(definitionsDir(root), `${id}${DEFINITION_SUFFIX}`);
}

/** Exact durable state used by the gateway's definition+trigger transaction. */
export type WorkflowDefinitionStateSnapshot = string | null;

export function captureDefinitionState(root: string, id: string): WorkflowDefinitionStateSnapshot {
  const file = definitionFile(root, id);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Restore bytes verbatim so rollback does not bump versions or rewrite metadata. */
export function restoreDefinitionState(root: string, id: string, snapshot: WorkflowDefinitionStateSnapshot): void {
  const file = definitionFile(root, id);
  if (snapshot === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  writeOverwrite(file, snapshot);
}

/**
 * Overwrite `file` atomically (unique temp write + rename). Used to persist an update
 * to an ALREADY-EXISTING definition. The rename is atomic, so a reader never sees a
 * torn file. (Not fsync-durable across power loss — out of scope; git is the archive.)
 */
function writeOverwrite(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Create `file` atomically AND exclusively: write a unique temp, then hard-link it into
 * place. `link` throws EEXIST if the destination already exists, which closes the
 * check-then-write race for a NEW definition within a single gateway process
 * (cross-process multi-writer is out of scope — GRS-011a storage decision defers it).
 * On EEXIST we surface a store `conflict`. Not fsync-durable across power loss.
 */
function writeExclusive(file: string, contents: string, id: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkflowStoreError('conflict', `workflow "${id}" already exists`);
    }
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Read+parse one definition from disk. Returns null for a missing file (→ 404),
 * throws `bad-input` for malformed JSON. Does NOT re-validate the schema — a stored
 * file was validated on write, and a hand-corrupted one should still be loadable into
 * the editor to be fixed; the WRITE paths are what guarantee schema validity on disk.
 */
function readOne(root: string, id: string): EditableWorkflowDefinition | null {
  const file = definitionFile(root, id);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as EditableWorkflowDefinition;
  } catch (e) {
    throw new WorkflowStoreError(
      'bad-input',
      `definition "${id}" on disk is not valid JSON: ${(e as Error).message}`,
    );
  }
}

function definitionName(def: EditableWorkflowDefinition): string {
  return def.name ?? def.id;
}

function definitions(root: string): EditableWorkflowDefinition[] {
  let names: string[];
  try {
    names = fs.readdirSync(definitionsDir(root));
  } catch {
    return [];
  }
  const out: EditableWorkflowDefinition[] = [];
  for (const fileName of names) {
    if (!fileName.endsWith(DEFINITION_SUFFIX)) continue;
    const id = fileName.slice(0, -DEFINITION_SUFFIX.length);
    if (!id) continue;
    try {
      const def = readOne(root, id);
      if (def) out.push(def);
    } catch {
      // A corrupt definition must not hide the rest of the registry.
    }
  }
  return out;
}

function assertNameAvailable(root: string, name: string, exceptId?: string): void {
  const existing = definitions(root).find((def) => def.id !== exceptId && definitionName(def) === name);
  if (existing) {
    throw new WorkflowStoreError(
      'conflict',
      `workflow name "${name}" is already used by workflow "${existing.id}"`,
    );
  }
}

/** Validate a to-be-written definition; throw a `validation` error carrying every problem. */
function assertValid(def: EditableWorkflowDefinition, what: string): void {
  const result = validateDefinition(def);
  if (!result.ok) {
    throw new WorkflowStoreError('validation', `${what} failed validation`, result.errors);
  }
}

function applyLayoutPolicy(
  def: EditableWorkflowDefinition,
  intent: WorkflowLayoutIntent,
): EditableWorkflowDefinition {
  const structural = validateDefinition(def);
  const blocking = structural.errors.filter((error) => error.code !== 'missing-node-position');
  if (blocking.length > 0) {
    throw new WorkflowStoreError('validation', 'definition failed validation', structural.errors);
  }
  try {
    return prepareWorkflowLayoutForWrite(def, intent).definition;
  } catch (error) {
    if (!(error instanceof WorkflowLayoutError)) throw error;
    throw new WorkflowStoreError(
      'validation',
      error.message,
      error.reasons.map((reason) => ({
        code: 'bad-layout',
        message: reason.message,
        ...(reason.refs?.length ? { ref: reason.refs.join(',') } : {}),
      })),
    );
  }
}

function hasSameLayoutGeometryAndTopology(
  existing: EditableWorkflowDefinition,
  candidate: EditableWorkflowDefinition,
): boolean {
  if (existing.nodes.length !== candidate.nodes.length || existing.edges.length !== candidate.edges.length) return false;
  const existingNodes = new Map(existing.nodes.map((node) => [node.id, node]));
  if (existingNodes.size !== existing.nodes.length) return false;
  for (const after of candidate.nodes) {
    const before = existingNodes.get(after.id);
    if (!before || before.position?.x !== after.position?.x || before.position?.y !== after.position?.y) {
      return false;
    }
  }
  const existingEdges = new Map(existing.edges.map((edge) => [edge.id, edge]));
  if (existingEdges.size !== existing.edges.length) return false;
  for (const after of candidate.edges) {
    const before = existingEdges.get(after.id);
    if (!before || before.from !== after.from || before.to !== after.to) return false;
  }
  return true;
}

function inferUpdateLayoutIntent(
  existing: EditableWorkflowDefinition,
  candidate: EditableWorkflowDefinition,
  patch: Partial<EditableWorkflowDefinition>,
): WorkflowLayoutIntent | undefined {
  if (patch.nodes === undefined && patch.edges === undefined) return undefined;
  if (!hasSameLayoutGeometryAndTopology(existing, candidate)) return 'generated';
  return existing.layout?.source === 'manual' ? 'manual' : 'generated';
}

/**
 * List definition summaries by scanning `<evidenceRoot>/workflows/*.definition.json`.
 * Tolerant: a single corrupt/unreadable file is skipped, not fatal, so one bad file
 * never breaks the workflow rail.
 */
export function listDefinitions(root: string): WorkflowDefinitionSummary[] {
  const out: WorkflowDefinitionSummary[] = [];
  for (const def of definitions(root)) {
    out.push({
      id: def.id,
      name: definitionName(def),
      title: def.title ?? def.id,
      status: def.status ?? 'active',
      version: typeof def.version === 'number' ? def.version : 0,
      ...(def.updatedAt ? { updatedAt: def.updatedAt } : {}),
      nodeCount: Array.isArray(def.nodes) ? def.nodes.length : 0,
      edgeCount: Array.isArray(def.edges) ? def.edges.length : 0,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Full definition, or null if it does not exist. */
export function getDefinition(root: string, id: string): EditableWorkflowDefinition | null {
  return readOne(root, id);
}

/** Resolve the one canonical workflow name. Duplicate hand-corrupted records fail loudly. */
export function getDefinitionByName(root: string, name: string): EditableWorkflowDefinition | null {
  assertValidName(name);
  const matches = definitions(root).filter((def) => definitionName(def) === name);
  if (matches.length > 1) {
    throw new WorkflowStoreError(
      'conflict',
      `workflow name "${name}" is ambiguous across ids: ${matches.map((def) => def.id).sort().join(', ')}`,
    );
  }
  return matches[0] ?? null;
}

/**
 * Create a new definition. Stamps schemaVersion, version=1, status (default active),
 * and updatedAt; validates; refuses if the id already exists (409).
 */
export function createDefinition(
  root: string,
  input: EditableWorkflowDefinition,
  opts: WriteOptions = {},
): EditableWorkflowDefinition {
  if (!input || typeof input !== 'object') {
    throw new WorkflowStoreError('bad-input', 'definition body is required');
  }
  assertSafeId(input.id);
  const now = (opts.now ?? defaultNow)();
  const name = input.name ?? input.id;
  assertValidName(name);
  // Preserve the existing duplicate-id contract: the exclusive file create below
  // remains authoritative when the matching registry row has this same id.
  assertNameAvailable(root, name, input.id);
  const { layout: _incomingLayout, ...safeInput } = input;
  const candidate: EditableWorkflowDefinition = {
    ...safeInput,
    name,
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    version: 1,
    status: input.status ?? 'active',
    updatedAt: now,
  };
  const def = opts.layoutIntent ? applyLayoutPolicy(candidate, opts.layoutIntent) : candidate;
  assertValid(def, 'definition');
  // Atomic exclusive create: no check-then-write gap — link fails if the id exists.
  writeExclusive(definitionFile(root, def.id), serializeDefinition(def), def.id);
  return def;
}

/**
 * Update an existing definition with a shallow patch (patch.nodes/edges/runGates
 * REPLACE the stored arrays — the canvas sends the full graph on save). Bumps version,
 * sets updatedAt, validates the merged result. The id is immutable. Optional
 * `expectedVersion` gives the editor optimistic locking (stale save → 409).
 */
export function updateDefinition(
  root: string,
  id: string,
  patch: Partial<EditableWorkflowDefinition>,
  opts: UpdateOptions = {},
): EditableWorkflowDefinition {
  assertSafeId(id);
  const existing = readOne(root, id);
  if (!existing) throw new WorkflowStoreError('not-found', `workflow "${id}" not found`);
  if (opts.expectedVersion !== undefined && existing.version !== opts.expectedVersion) {
    throw new WorkflowStoreError(
      'conflict',
      `version conflict: expected ${opts.expectedVersion}, on disk ${existing.version}`,
    );
  }
  if (patch && typeof patch === 'object' && patch.id !== undefined && patch.id !== id) {
    throw new WorkflowStoreError('bad-input', 'workflow id cannot be changed via update');
  }
  const existingName = definitionName(existing);
  if (patch && typeof patch === 'object' && patch.name !== undefined && patch.name !== existingName) {
    throw new WorkflowStoreError('bad-input', 'workflow name cannot be changed via update');
  }
  const now = (opts.now ?? defaultNow)();
  const candidate: EditableWorkflowDefinition = {
    ...existing,
    ...patch,
    // A patch cannot self-assert provenance. Preserve only the server-owned value
    // already on disk; an explicit write policy below will replace it.
    ...(existing.layout ? { layout: existing.layout } : { layout: undefined }),
    id, // id is immutable regardless of patch
    name: existingName,
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    version: existing.version + 1,
    updatedAt: now,
  };
  const effectiveLayoutIntent = opts.layoutIntent ?? inferUpdateLayoutIntent(existing, candidate, patch);
  const merged = effectiveLayoutIntent ? applyLayoutPolicy(candidate, effectiveLayoutIntent) : candidate;
  assertValid(merged, 'definition');
  writeOverwrite(definitionFile(root, id), serializeDefinition(merged));
  return merged;
}

/**
 * Duplicate a definition under a new id. The copy resets to version=1, status=active,
 * title `<title> (copy)` (unless overridden). An explicit `newId` that is taken → 409;
 * the default `<id>-copy` auto-disambiguates to `<id>-copy-2`, `-3`, …
 */
export function duplicateDefinition(
  root: string,
  id: string,
  opts: DuplicateOptions = {},
): EditableWorkflowDefinition {
  assertSafeId(id);
  const existing = readOne(root, id);
  if (!existing) throw new WorkflowStoreError('not-found', `workflow "${id}" not found`);
  const now = (opts.now ?? defaultNow)();

  let newId = opts.newId ?? `${id}-copy`;
  assertSafeId(newId);
  let n = 2;
  while (fs.existsSync(definitionFile(root, newId))) {
    if (opts.newId) {
      throw new WorkflowStoreError('conflict', `workflow "${newId}" already exists`);
    }
    newId = `${id}-copy-${n++}`;
    assertSafeId(newId);
  }

  const requestedName = opts.definitionPatch?.name;
  const newName = typeof requestedName === 'string' ? requestedName : newId;
  assertValidName(newName);
  assertNameAvailable(root, newName);

  const candidate: EditableWorkflowDefinition = {
    ...existing,
    ...(opts.definitionPatch ?? {}),
    ...(existing.layout ? { layout: existing.layout } : { layout: undefined }),
    id: newId,
    name: newName,
    title: opts.title ?? `${existing.title} (copy)`,
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    version: 1,
    status: 'active',
    updatedAt: now,
  };
  const dup = opts.layoutIntent ? applyLayoutPolicy(candidate, opts.layoutIntent) : candidate;
  assertValid(dup, 'duplicated definition');
  // Exclusive create closes the gap between the existsSync id-scan above and the write.
  writeExclusive(definitionFile(root, newId), serializeDefinition(dup), newId);
  return dup;
}

/**
 * Retire (soft-delete) a definition: set status=retired, bump version. The file stays
 * on disk (git is the archive) so run receipts that reference it keep resolving — a
 * retire is reversible via update, a hard delete would not be.
 */
export function retireDefinition(
  root: string,
  id: string,
  opts: WriteOptions = {},
): EditableWorkflowDefinition {
  assertSafeId(id);
  const existing = readOne(root, id);
  if (!existing) throw new WorkflowStoreError('not-found', `workflow "${id}" not found`);
  const now = (opts.now ?? defaultNow)();
  const retired: EditableWorkflowDefinition = {
    ...existing,
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    status: 'retired',
    version: existing.version + 1,
    updatedAt: now,
  };
  assertValid(retired, 'retired definition');
  writeOverwrite(definitionFile(root, id), serializeDefinition(retired));
  return retired;
}
