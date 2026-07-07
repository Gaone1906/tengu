import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-delq-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

function queueRowCount(sessionId: string): number {
  const db = reg.initDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM queue_items WHERE session_id = ?")
    .get(sessionId) as { count: number };
  return row.count;
}

function queueStatus(itemId: string): string | null {
  const db = reg.initDb();
  const row = db
    .prepare("SELECT status FROM queue_items WHERE id = ?")
    .get(itemId) as { status: string } | undefined;
  return row?.status ?? null;
}

describe("deleteSession/deleteSessions queue_items cleanup", () => {
  it("deleteSession removes the session's queue_items rows", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-1" });
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");
    expect(queueRowCount(session.id)).toBe(1);

    expect(reg.deleteSession(session.id)).toBe(true);
    expect(queueRowCount(session.id)).toBe(0);
  });

  it("deleteSessions removes queue_items for every deleted session", () => {
    const a = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-2" });
    const b = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-3" });
    reg.enqueueQueueItem(a.id, a.sessionKey, "a-1");
    reg.enqueueQueueItem(b.id, b.sessionKey, "b-1");

    expect(reg.deleteSessions([a.id, b.id])).toBe(2);
    expect(queueRowCount(a.id)).toBe(0);
    expect(queueRowCount(b.id)).toBe(0);
  });
});

describe("markRunningQueueItemsCompletedForSession", () => {
  it("completes only running queue rows for the requesting session", () => {
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:restart-loop" });
    const other = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:other-running" });
    const running = reg.enqueueQueueItem(session.id, session.sessionKey, "Restart the gateway.");
    const pending = reg.enqueueQueueItem(session.id, session.sessionKey, "Next normal message");
    const otherRunning = reg.enqueueQueueItem(other.id, other.sessionKey, "Unrelated work");
    reg.markQueueItemRunning(running);
    reg.markQueueItemRunning(otherRunning);

    expect(reg.markRunningQueueItemsCompletedForSession(session.id)).toBe(1);

    expect(queueStatus(running)).toBe("completed");
    expect(queueStatus(pending)).toBe("pending");
    expect(queueStatus(otherRunning)).toBe("running");
  });
});
