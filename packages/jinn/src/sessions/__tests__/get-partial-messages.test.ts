import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from JINN_HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-getpartial-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

function newSession(id: string): void {
  reg.initDb().prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude','web',?, 'running','t','t')",
  ).run(id, `web:${id}`);
}

beforeAll(async () => {
  reg = await import("../registry.js");
});

describe("getPartialMessages (bounded turn-settle read)", () => {
  it("returns only partial rows, in stream (seq) order, leaving final history out", () => {
    newSession("getpartial-s1");
    reg.insertMessage("getpartial-s1", "user", "question");
    reg.insertMessage("getpartial-s1", "assistant", "an older final answer");
    // Pin the clock so all three partials share a timestamp — then `seq` (not
    // insertion time) must order them, which is exactly the tie-break we assert.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      reg.insertPartialMessage("getpartial-s1", "assistant", "third", 2);
      reg.insertPartialMessage("getpartial-s1", "assistant", "first", 0);
      reg.insertPartialMessage("getpartial-s1", "assistant", "second", 1, "Bash");
    } finally {
      clock.mockRestore();
    }

    const partials = reg.getPartialMessages("getpartial-s1");
    expect(partials.map((m) => m.content)).toEqual(["first", "second", "third"]);
    expect(partials.every((m) => m.partial === true)).toBe(true);
    expect(partials[1].toolCall).toBe("Bash");

    // Equivalent to the old getMessages(...).filter(m => m.partial) it replaces.
    const viaFull = reg.getMessages("getpartial-s1").filter((m) => m.partial);
    expect(partials.map((m) => m.content)).toEqual(viaFull.map((m) => m.content));
  });

  it("reads via an index seek, never a full messages table scan", () => {
    const db = reg.initDb();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT rowid, id, role, content, timestamp, media, partial, seq, tool_call, blocks FROM messages WHERE session_id = ? AND partial = 1 ORDER BY timestamp ASC, COALESCE(seq, 0) ASC, rowid ASC",
      )
      .all("getpartial-s1") as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join("\n");
    // The point of the change is bounded materialization: the DB seeks by
    // session_id (SEARCH ... USING INDEX) so it never full-SCANs the messages
    // table, and JS then holds only the handful of partial rows — not the whole
    // transcript. Whether SQLite picks idx_messages_partial or the session index
    // to satisfy the seek, a bare "SCAN messages" (unindexed full scan) is the
    // regression this guards against.
    expect(text).toContain("USING INDEX");
    const bareScan = plan.some(
      (r) => /\bSCAN\b/.test(r.detail) && !/USING\s+(COVERING\s+)?INDEX/.test(r.detail),
    );
    expect(bareScan).toBe(false);
  });

  it("returns nothing for a session with no live partials", () => {
    newSession("getpartial-s2");
    reg.insertMessage("getpartial-s2", "assistant", "only a final message");
    expect(reg.getPartialMessages("getpartial-s2")).toEqual([]);
  });
});
