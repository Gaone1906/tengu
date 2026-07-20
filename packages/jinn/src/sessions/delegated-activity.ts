import type { DelegatedActivity, Session } from "../shared/types.js";

interface MutableDelegatedActivity {
  activeSessions: number;
  employees: Set<string>;
}

/**
 * Build the derived "work still happening below me" summary for every parent.
 * Active sessions propagate through the entire ancestor chain; graph cycles are
 * contained and an active session is never counted as its own descendant.
 */
export function buildDelegatedActivityIndex(
  sessions: readonly Session[],
  activeSessionIds: ReadonlySet<string>,
): Map<string, DelegatedActivity> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const mutable = new Map<string, MutableDelegatedActivity>();

  for (const activeId of activeSessionIds) {
    const active = byId.get(activeId);
    if (!active) continue;

    const visited = new Set([active.id]);
    let parentId = active.parentSessionId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const summary = mutable.get(parentId) ?? { activeSessions: 0, employees: new Set<string>() };
      summary.activeSessions += 1;
      if (active.employee) summary.employees.add(active.employee);
      mutable.set(parentId, summary);
      parentId = byId.get(parentId)?.parentSessionId ?? null;
    }
  }

  return new Map(
    [...mutable].map(([sessionId, summary]) => [
      sessionId,
      {
        activeSessions: summary.activeSessions,
        employees: [...summary.employees].sort(),
      },
    ]),
  );
}
