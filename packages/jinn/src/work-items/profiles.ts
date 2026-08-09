import { randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Profile registry (docs/tengu/18-council-specialists.md, D22): a user-
 * defined namespace inside one running instance (work/personal/side-project/
 * hobby/...) — modeled on `departments.ts`'s lazy-registration pattern, minus
 * the ID-prefix derivation departments need and a profile never does.
 * `resolveProfile` is get-or-create by slug so a repeat create is never a
 * duplicate; registration races resolve via the UNIQUE constraint on `slug`,
 * same recovery shape as `resolveDepartmentPrefix`.
 */

export interface ProfileRecord {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  createdAt: string;
}

function rowToProfile(row: Record<string, unknown>): ProfileRecord {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    color: (row.color as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function listProfiles(db: DatabaseType): ProfileRecord[] {
  return (db.prepare("SELECT * FROM profiles ORDER BY slug").all() as Record<string, unknown>[]).map(rowToProfile);
}

/** Resolve (lazily registering) the profile for a slug. An existing row wins
 *  over `name`/`color` — those apply only to a first-time registration, the
 *  same way `resolveDepartmentPrefix` ignores its inputs on a cache hit. */
export function resolveProfile(db: DatabaseType, slug: string, name?: string, color?: string | null): ProfileRecord {
  const existing = db.prepare("SELECT * FROM profiles WHERE slug = ?").get(slug) as Record<string, unknown> | undefined;
  if (existing) return rowToProfile(existing);
  const record: ProfileRecord = {
    id: `prf_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    slug,
    name: name ?? slug,
    color: color ?? null,
    createdAt: new Date().toISOString(),
  };
  try {
    db.prepare("INSERT INTO profiles (id, slug, name, color, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(record.id, record.slug, record.name, record.color, record.createdAt);
    return record;
  } catch (err) {
    // Only a constraint collision means we lost a registration race; anything
    // else (I/O, readonly, …) must surface instead of recursing forever.
    const code = (err as { code?: string } | null)?.code;
    if (code !== "SQLITE_CONSTRAINT_UNIQUE" && code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw err;
    const winner = db.prepare("SELECT * FROM profiles WHERE slug = ?").get(slug) as Record<string, unknown> | undefined;
    if (winner) return rowToProfile(winner);
    return resolveProfile(db, slug, name, color);
  }
}
