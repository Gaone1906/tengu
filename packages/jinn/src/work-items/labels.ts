import { randomUUID } from 'node:crypto';
import { initDb } from '../sessions/registry.js';
import { parseTodoId } from './id.js';
import { appendWorkItemEvent } from './store.js';

/**
 * Work-item labels — the shared tag registry and per-Todo label sets (Todos v2
 * slice 3).
 *
 * Semantics (design decisions, locked):
 * - Label names are normalized to lowercase kebab-case and UNIQUE; `department`
 *   NULL = company-wide. Creation authority (operator or a manager) lives at the
 *   route layer; this module is the storage truth.
 * - NO implicit label creation: `setWorkItemLabels` accepts existing label ids
 *   or names only — an unknown name throws listing the valid labels.
 * - Replacing a Todo's set appends ONE `label_changed` event with the resulting
 *   names (`versionEffect: 'state'`), and only on an actual change.
 */

export interface Label {
  id: string; // lbl_<12hex>
  name: string;
  color: string | null;
  department: string | null;
  createdAt: string;
}

const LABEL_ID_PATTERN = /^lbl_[0-9a-f]{12}$/;
const LABEL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Normalize a label name to lowercase kebab-case: runs of anything that is not
 *  a letter or digit collapse to single dashes. Throws when nothing survives. */
export function normalizeLabelName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error(`label name "${name}" must contain at least one letter or digit`);
  return normalized;
}

function rowToLabel(row: Record<string, unknown>): Label {
  return {
    id: row.id as string,
    name: row.name as string,
    color: (row.color as string) ?? null,
    department: (row.department as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Create a label. The name is normalized to kebab-case; a normalized-name
 * collision (including a lost UNIQUE race) returns the existing label unchanged
 * rather than erroring or overwriting.
 */
export function createLabel(input: { name: string; color?: string | null; department?: string | null }): Label {
  const db = initDb();
  const name = normalizeLabelName(input.name);
  const color = input.color ?? null;
  if (color !== null && !LABEL_COLOR_PATTERN.test(color)) {
    throw new Error(`label color must be a 6-digit hex value such as #22cc88, got "${color}"`);
  }
  const department = typeof input.department === 'string' && input.department.trim() ? input.department.trim() : null;
  const selectByName = (): Label | undefined => {
    const row = db.prepare('SELECT * FROM labels WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    return row ? rowToLabel(row) : undefined;
  };
  const existing = selectByName();
  if (existing) return existing;
  const label: Label = {
    id: `lbl_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name,
    color,
    department,
    createdAt: new Date().toISOString(),
  };
  try {
    db.prepare('INSERT INTO labels (id, name, color, department, created_at) VALUES (?, ?, ?, ?, ?)').run(
      label.id,
      label.name,
      label.color,
      label.department,
      label.createdAt,
    );
  } catch (err) {
    // Lost the UNIQUE race — another writer registered the name first.
    if (isUniqueConstraintError(err)) {
      const winner = selectByName();
      if (winner) return winner;
    }
    throw err;
  }
  return label;
}

/** All labels, ordered by name. */
export function listLabels(): Label[] {
  const db = initDb();
  return (db.prepare('SELECT * FROM labels ORDER BY name').all() as Record<string, unknown>[]).map(rowToLabel);
}

/** Resolve a caller-supplied label reference (id or name, pre-normalization) to
 *  an existing label. Returns undefined when nothing matches. */
function resolveLabel(db: ReturnType<typeof initDb>, ref: string): Label | undefined {
  if (LABEL_ID_PATTERN.test(ref)) {
    const row = db.prepare('SELECT * FROM labels WHERE id = ?').get(ref) as Record<string, unknown> | undefined;
    if (row) return rowToLabel(row);
  }
  let name: string;
  try {
    name = normalizeLabelName(ref);
  } catch {
    return undefined;
  }
  const row = db.prepare('SELECT * FROM labels WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  return row ? rowToLabel(row) : undefined;
}

/**
 * Replace a Todo's label set. Entries may be label ids or names; every entry
 * must resolve to an EXISTING label (no implicit creation) — an unknown entry
 * throws listing the valid labels. Appends one `label_changed` event with the
 * resulting names, only when the set actually changes. Returns the new set
 * ordered by name.
 */
export function setWorkItemLabels(workItemId: string, labelRefs: string[], actor: string): Label[] {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const txn = db.transaction((): Label[] => {
    if (!db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(id)) {
      throw new Error(`Todo ${id} not found`);
    }
    const resolved = new Map<string, Label>();
    for (const ref of labelRefs) {
      const label = resolveLabel(db, ref);
      if (!label) {
        const valid = listLabels().map((l) => l.name);
        throw new Error(
          `unknown label "${ref}" — labels are never created implicitly; valid labels: ${valid.length ? valid.join(', ') : '(none yet — create one first)'}`,
        );
      }
      resolved.set(label.id, label);
    }
    const next = [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name));
    const current = getWorkItemLabels(id);
    if (current.length === next.length && current.every((label, index) => label.id === next[index].id)) {
      return current; // unchanged — no writes, no event
    }
    db.prepare('DELETE FROM work_item_labels WHERE work_item_id = ?').run(id);
    for (const label of next) {
      db.prepare('INSERT INTO work_item_labels (work_item_id, label_id) VALUES (?, ?)').run(id, label.id);
    }
    appendWorkItemEvent({
      workItemId: id,
      kind: 'label_changed',
      actor,
      detail: { labels: next.map((label) => label.name) },
      versionEffect: 'state', // re-tagging resorts activity-ordered lists
    });
    return next;
  });
  return txn();
}

/** A Todo's labels, ordered by name. An unknown Todo reads as empty — existence
 *  404s belong to the route layer. */
export function getWorkItemLabels(workItemId: string): Label[] {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const rows = db
    .prepare(
      `SELECT l.* FROM work_item_labels wil JOIN labels l ON l.id = wil.label_id
       WHERE wil.work_item_id = ? ORDER BY l.name`,
    )
    .all(id) as Record<string, unknown>[];
  return rows.map(rowToLabel);
}

/** Batch form of `getWorkItemLabels` for list payloads: ONE query for the whole
 *  page, never per-item. Every requested id is present in the Map (empty array
 *  when unlabelled). */
export function labelSets(workItemIds: string[]): Map<string, Label[]> {
  const sets = new Map<string, Label[]>();
  if (workItemIds.length === 0) return sets;
  const db = initDb();
  const ids = workItemIds.map((id) => parseTodoId(id));
  for (const id of ids) sets.set(id, []);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT wil.work_item_id, l.* FROM work_item_labels wil JOIN labels l ON l.id = wil.label_id
       WHERE wil.work_item_id IN (${placeholders}) ORDER BY l.name`,
    )
    .all(...ids) as Record<string, unknown>[];
  for (const row of rows) {
    sets.get(row.work_item_id as string)!.push(rowToLabel(row));
  }
  return sets;
}
