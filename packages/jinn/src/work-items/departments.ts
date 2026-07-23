import type { Database as DatabaseType } from "better-sqlite3";
import { deriveTodoIdPrefix } from "./id.js";

/**
 * Per-department Todo ID prefixes (Todos v2 slice 1). A department's prefix is
 * derived once, registered in the `departments` table (Task 3), and never
 * changes; items keep their birth prefix even if they later move departments.
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Derive the 3-letter candidate for a department slug. Falls back to X-padding
 *  for short/letterless slugs instead of throwing like the company derivation. */
export function derivePrefixCandidate(slug: string): string {
  try {
    return deriveTodoIdPrefix(slug);
  } catch {
    const letters = slug.toUpperCase().replace(/[^A-Z]/g, "");
    return `${letters}XXX`.slice(0, 3);
  }
}

/** Deterministic collision fallback: try the candidate, then advance the third
 *  letter A→Z, then the second, then the first. Throws only if every variant of
 *  all three positions is taken (78 tries — practically impossible). */
export function pickFreePrefix(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let position = 2; position >= 0; position--) {
    for (const letter of LETTERS) {
      const attempt = candidate.slice(0, position) + letter + candidate.slice(position + 1);
      if (!taken.has(attempt)) return attempt;
    }
  }
  throw new Error(`no free Todo ID prefix near ${candidate}`);
}

/** Resolve (lazily registering) the immutable ID prefix for a department slug.
 *  `reservedCompanyPrefix` is the company namespace and can never be assigned
 *  to a department. Registration races resolve via the UNIQUE constraint. */
export function resolveDepartmentPrefix(db: DatabaseType, slug: string, reservedCompanyPrefix: string): string {
  const existing = db.prepare("SELECT prefix FROM departments WHERE slug = ?").get(slug) as { prefix: string } | undefined;
  if (existing) return existing.prefix;
  const taken = new Set(db.prepare("SELECT prefix FROM departments").pluck().all() as string[]);
  // Every allocated namespace is reserved too — a retired company prefix keeps
  // its history and must never be silently claimed by a department (two
  // semantically different sequences would interleave under one prefix).
  for (const allocated of db.prepare("SELECT prefix FROM work_item_id_allocator").pluck().all() as string[]) {
    taken.add(allocated);
  }
  taken.add(reservedCompanyPrefix);
  const prefix = pickFreePrefix(derivePrefixCandidate(slug), taken);
  try {
    db.prepare("INSERT INTO departments (slug, prefix, created_at) VALUES (?, ?, ?)")
      .run(slug, prefix, new Date().toISOString());
    return prefix;
  } catch (err) {
    // Only a constraint collision means we lost a registration race; anything
    // else (I/O, readonly, …) must surface instead of recursing forever.
    const code = (err as { code?: string } | null)?.code;
    if (code !== "SQLITE_CONSTRAINT_UNIQUE" && code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw err;
    const winner = db.prepare("SELECT prefix FROM departments WHERE slug = ?").get(slug) as { prefix: string } | undefined;
    if (winner) return winner.prefix;
    return resolveDepartmentPrefix(db, slug, reservedCompanyPrefix);
  }
}

export interface DepartmentRecord { slug: string; prefix: string; createdAt: string }

export function listDepartments(db: DatabaseType): DepartmentRecord[] {
  return (db.prepare("SELECT slug, prefix, created_at FROM departments ORDER BY slug").all() as Array<Record<string, string>>)
    .map((row) => ({ slug: row.slug, prefix: row.prefix, createdAt: row.created_at }));
}

export interface DepartmentSummary extends DepartmentRecord {
  /** Live count of Todos currently IN the department (items keep their birth
   *  prefix when moved, so this counts membership, not the ID namespace). */
  todoCount: number;
}

/** The `GET /api/departments` surface: registry rows + one GROUP BY count. */
export function listDepartmentsWithCounts(db: DatabaseType): DepartmentSummary[] {
  return (
    db
      .prepare(
        `SELECT d.slug, d.prefix, d.created_at, COUNT(w.id) AS todo_count
         FROM departments d
         LEFT JOIN work_items w ON w.department = d.slug
         GROUP BY d.slug
         ORDER BY d.slug`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({
    slug: row.slug as string,
    prefix: row.prefix as string,
    createdAt: row.created_at as string,
    todoCount: Number(row.todo_count),
  }));
}
