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
