import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  serializeDefinition,
  validateDefinition,
  type EditableWorkflowDefinition,
  type ValidationError,
} from './definition.js';

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
  title: string;
  status: EditableWorkflowDefinition['status'];
  version: number;
  updatedAt?: string;
  nodeCount: number;
  edgeCount: number;
}

export type WorkflowStoreErrorCode =
  | 'invalid-id'
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

function definitionsDir(root: string): string {
  return path.join(root, 'workflows');
}

function definitionFile(root: string, id: string): string {
  assertSafeId(id);
  return path.join(definitionsDir(root), `${id}${DEFINITION_SUFFIX}`);
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

/** Validate a to-be-written definition; throw a `validation` error carrying every problem. */
function assertValid(def: EditableWorkflowDefinition, what: string): void {
  const result = validateDefinition(def);
  if (!result.ok) {
    throw new WorkflowStoreError('validation', `${what} failed validation`, result.errors);
  }
}

/**
 * List definition summaries by scanning `<evidenceRoot>/workflows/*.definition.json`.
 * Tolerant: a single corrupt/unreadable file is skipped, not fatal, so one bad file
 * never breaks the workflow rail.
 */
export function listDefinitions(root: string): WorkflowDefinitionSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(definitionsDir(root));
  } catch {
    return [];
  }
  const out: WorkflowDefinitionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(DEFINITION_SUFFIX)) continue;
    const id = name.slice(0, -DEFINITION_SUFFIX.length);
    if (!id) continue;
    let def: EditableWorkflowDefinition | null;
    try {
      def = readOne(root, id);
    } catch {
      continue; // skip corrupt/unsafe-named files
    }
    if (!def) continue;
    out.push({
      id: def.id ?? id,
      title: def.title ?? id,
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
  const def: EditableWorkflowDefinition = {
    ...input,
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    version: 1,
    status: input.status ?? 'active',
    updatedAt: now,
  };
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
  const now = (opts.now ?? defaultNow)();
  const merged: EditableWorkflowDefinition = {
    ...existing,
    ...patch,
    id, // id is immutable regardless of patch
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    version: existing.version + 1,
    updatedAt: now,
  };
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

  const dup: EditableWorkflowDefinition = {
    ...existing,
    ...(opts.definitionPatch ?? {}),
    id: newId,
    title: opts.title ?? `${existing.title} (copy)`,
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    version: 1,
    status: 'active',
    updatedAt: now,
  };
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
