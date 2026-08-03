import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * GRS-020a — the company-reference search primitives:
 *   - searchMessages() filter extensions (sessionId/employee/engine/role/since/
 *     until as bound-param SQL) + the messageId anchor in results
 *   - searchSessionsFiltered() — AND-composed structured session search with
 *     escaped-LIKE text over {title, prompt_excerpt, id}
 *   - getMessageContext() — bounded ±radius window around a message anchor,
 *     with complete message bodies
 *
 * Own file (not registry-search-messages.test.ts) because that suite ends by
 * disabling FTS for its process — these tests need a live index throughout.
 */

// Point the DB at a throwaway dir BEFORE importing the registry.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-ref-search-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Reg = typeof import("../registry.js");
let reg: Reg;

let seq = 0;
function mkSession(
  id: string,
  fields: { employee?: string; engine?: string; status?: string; source?: string; title?: string; promptExcerpt?: string; parent?: string; lastActivity?: string; createdAt?: string } = {},
): void {
  const db = dbModule.initDb();
  db.prepare(
    `INSERT INTO sessions (id, engine, employee, source, source_ref, status, title, prompt_excerpt, parent_session_id, created_at, last_activity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.engine ?? "claude",
    fields.employee ?? null,
    fields.source ?? "web",
    `web:${id}`,
    fields.status ?? "idle",
    fields.title ?? null,
    fields.promptExcerpt ?? null,
    fields.parent ?? null,
    fields.createdAt ?? "2026-07-01T00:00:00.000Z",
    fields.lastActivity ?? "2026-07-01T00:00:00.000Z",
  );
}
function mkMessage(sessionId: string, role: string, content: string, ts: number): string {
  const id = `m${seq++}`;
  dbModule.initDb()
    .prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(id, sessionId, role, content, ts);
  return id;
}

beforeAll(async () => {
  reg = await import("../registry.js");
  dbModule.initDb();
});

describe("searchMessages — filters + messageId anchor (GRS-020a)", () => {
  it("returns the messageId anchor and the owning session's employee/engine on every hit", () => {
    mkSession("sm-anchor", { employee: "alpha-dev", engine: "codex" });
    const mid = mkMessage("sm-anchor", "assistant", "the aardwolf decision was approved", 1000);

    const hits = reg.searchMessages("aardwolf");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      messageId: mid,
      sessionId: "sm-anchor",
      role: "assistant",
      timestamp: 1000,
      employee: "alpha-dev",
      engine: "codex",
    });
    expect(hits[0].snippet).toContain("«aardwolf»");
  });

  it("filters by sessionId, role, and time range — all AND-composed", () => {
    mkSession("sm-f1");
    mkSession("sm-f2");
    mkMessage("sm-f1", "user", "bandicoot question early", 2000);
    mkMessage("sm-f1", "assistant", "bandicoot answer late", 2010);
    mkMessage("sm-f2", "assistant", "bandicoot elsewhere", 2020);

    expect(reg.searchMessages("bandicoot", 50, { sessionId: "sm-f1" }).map((r) => r.timestamp).sort()).toEqual([2000, 2010]);
    expect(reg.searchMessages("bandicoot", 50, { sessionId: "sm-f1", role: "user" }).map((r) => r.timestamp)).toEqual([2000]);
    expect(reg.searchMessages("bandicoot", 50, { since: 2005, until: 2015 }).map((r) => r.timestamp)).toEqual([2010]);
    expect(reg.searchMessages("bandicoot", 50, { sessionId: "sm-f1", since: 2015 })).toEqual([]);
  });

  it("filters by employee and engine (case-insensitive) via the sessions join", () => {
    mkSession("sm-emp1", { employee: "beta-dev", engine: "codex" });
    mkSession("sm-emp2", { employee: "gamma-dev", engine: "claude" });
    mkMessage("sm-emp1", "assistant", "quoll report alpha", 3000);
    mkMessage("sm-emp2", "assistant", "quoll report beta", 3001);

    const byEmp = reg.searchMessages("quoll", 50, { employee: "Beta-Dev" });
    expect(byEmp.map((r) => r.sessionId)).toEqual(["sm-emp1"]);
    const byEngine = reg.searchMessages("quoll", 50, { engine: "CLAUDE" });
    expect(byEngine.map((r) => r.sessionId)).toEqual(["sm-emp2"]);
    expect(reg.searchMessages("quoll", 50, { employee: "beta-dev", engine: "claude" })).toEqual([]);
  });

  it("a message whose session row is missing still matches when no session-field filter is passed (LEFT JOIN)", () => {
    // Orphan message (no sessions row) — defensive: deleteSession removes both,
    // but the search must not silently hide rows if the invariant ever breaks.
    mkMessage("sm-ghost", "assistant", "numbat orphan note", 4000);
    const hits = reg.searchMessages("numbat");
    expect(hits.map((r) => r.sessionId)).toEqual(["sm-ghost"]);
    expect(hits[0].employee).toBeNull();
    // ...but an employee filter cannot match it.
    expect(reg.searchMessages("numbat", 50, { employee: "anyone" })).toEqual([]);
  });

  it("excludeSessionId drops one session's hits (the self-exclusion primitive — GRS-020a-fix finding 1)", () => {
    mkSession("sm-excl-me");
    mkSession("sm-excl-other");
    mkMessage("sm-excl-me", "user", "searching for the ocelot decision", 4500);
    mkMessage("sm-excl-other", "assistant", "the ocelot decision was recorded here", 4400);

    // Unfiltered, the caller's own (newer) message is the top hit — the trap.
    const all = reg.searchMessages("ocelot decision");
    expect(all[0].sessionId).toBe("sm-excl-me");
    // Excluded, only the other session's hit remains.
    const excluded = reg.searchMessages("ocelot decision", 50, { excludeSessionId: "sm-excl-me" });
    expect(excluded.map((r) => r.sessionId)).toEqual(["sm-excl-other"]);
    // Composes with other filters.
    expect(reg.searchMessages("ocelot", 50, { excludeSessionId: "sm-excl-me", role: "assistant" }).map((r) => r.sessionId)).toEqual([
      "sm-excl-other",
    ]);
  });

  it("NUL and control bytes in the query yield a normal result, never a throw (GRS-020a-fix finding 2)", () => {
    mkSession("sm-nul");
    mkMessage("sm-nul", "assistant", "the ibex token is safe", 4600);

    // NUL alone / control-only queries -> empty, no "unterminated string".
    expect(() => reg.searchMessages("\u0000")).not.toThrow();
    expect(reg.searchMessages("\u0000")).toEqual([]);
    expect(reg.searchMessages("\u0001\u0002\u001f\u007f")).toEqual([]);
    // NUL embedded in a word acts as a separator -- the honest tokens still match.
    expect(() => reg.searchMessages("ibex\u0000token")).not.toThrow();
    expect(reg.searchMessages("ibex\u0000token").map((r) => r.sessionId)).toEqual(["sm-nul"]);
    // The reviewer's exact live shape: term + trailing %00.
    expect(reg.searchMessages("ibex\u0000").map((r) => r.sessionId)).toEqual(["sm-nul"]);
    // NUL in a bound filter value must not throw either (it just won't match).
    expect(() => reg.searchMessages("ibex", 50, { employee: "a\u0000b" })).not.toThrow();
    expect(reg.searchMessages("ibex", 50, { employee: "a\u0000b" })).toEqual([]);
  });

  it("stays injection-inert with filters engaged: FTS operators and SQL metacharacters are literal text", () => {
    mkSession("sm-inj");
    mkMessage("sm-inj", "assistant", "the drop-table plan was rejected", 5000);

    const hostile = [
      `drop-table"; DROP TABLE messages; --`,
      `* NEAR( - "unbalanced`,
      `'; SELECT * FROM sessions; --`,
      `col:value AND (a OR b)`,
    ];
    for (const q of hostile) {
      expect(() => reg.searchMessages(q, 50, { sessionId: "sm-inj", role: "assistant" })).not.toThrow();
    }
    // The sanitizer strips `"` and phrases tokens — the words still match.
    const hits = reg.searchMessages(`drop-table" rejected`, 50, { sessionId: "sm-inj" });
    expect(hits).toHaveLength(1);
    // And the tables survived.
    expect(reg.searchMessages("rejected", 50, { sessionId: "sm-inj" })).toHaveLength(1);
  });
});

describe("searchSessionsFiltered (GRS-020a)", () => {
  beforeAll(() => {
    // Employee names are unique to THIS suite — the messages suite above shares
    // the DB, so unscoped assertions must not collide with its fixtures.
    mkSession("ss-a", { employee: "alpha-writer", engine: "codex", status: "idle", source: "web", title: "Alpha blog sprint", promptExcerpt: "write the blog", lastActivity: "2026-07-02T10:00:00.000Z" });
    mkSession("ss-b", { employee: "alpha-writer", engine: "codex", status: "error", source: "cron", title: "Nightly digest", lastActivity: "2026-07-03T10:00:00.000Z" });
    mkSession("ss-c", { employee: "beta-writer", engine: "claude", status: "interrupted", source: "web", title: "Beta pricing", parent: "ss-a", lastActivity: "2026-07-04T10:00:00.000Z" });
    mkSession("ss-d", { employee: "adhoc-runner", engine: "claude", status: "running", source: "slack", title: "Ad-hoc 100% run", promptExcerpt: "an under_score task", lastActivity: "2026-07-05T10:00:00.000Z" });
  });

  it("requires at least one filter (guards the unbounded full scan)", () => {
    expect(() => reg.searchSessionsFiltered({})).toThrow(/at least one filter/i);
  });

  it("AND-composes structured filters and orders by last_activity DESC", () => {
    const byEmp = reg.searchSessionsFiltered({ employee: "ALPHA-writer" });
    expect(byEmp.map((s) => s.id)).toEqual(["ss-b", "ss-a"]); // newest first, case-insensitive
    expect(reg.searchSessionsFiltered({ employee: "alpha-writer", status: "error" }).map((s) => s.id)).toEqual(["ss-b"]);
    expect(reg.searchSessionsFiltered({ employee: "beta-writer", engine: "claude", source: "web" }).map((s) => s.id)).toEqual(["ss-c"]);
    expect(reg.searchSessionsFiltered({ parentSessionId: "ss-a" }).map((s) => s.id)).toEqual(["ss-c"]);
  });

  it("text searches title + prompt_excerpt + id with %/_ as LITERAL characters (escaped LIKE)", () => {
    expect(reg.searchSessionsFiltered({ text: "pricing" }).map((s) => s.id)).toEqual(["ss-c"]);
    expect(reg.searchSessionsFiltered({ text: "write the blog" }).map((s) => s.id)).toEqual(["ss-a"]);
    expect(reg.searchSessionsFiltered({ text: "ss-d" }).map((s) => s.id)).toEqual(["ss-d"]);
    // `%` and `_` are literals: "100%" / "under_score" match only the row that
    // CONTAINS those characters, and a bare "%" matches only the literal-% row
    // (NOT everything — unescaped it would be a match-all wildcard).
    expect(reg.searchSessionsFiltered({ text: "100%" }).map((s) => s.id)).toEqual(["ss-d"]);
    expect(reg.searchSessionsFiltered({ text: "under_score" }).map((s) => s.id)).toEqual(["ss-d"]);
    expect(reg.searchSessionsFiltered({ text: "%" }).map((s) => s.id)).toEqual(["ss-d"]);
    expect(reg.searchSessionsFiltered({ text: "zz%zz" })).toEqual([]);
  });

  it("treats backslash literally under LIKE ... ESCAPE (GRS-020a-fix finding 4)", () => {
    mkSession("ss-bs", { employee: "backslash-owner", title: "literal backslash \\bar fixture", lastActivity: "2026-07-05T12:00:00.000Z" });
    mkSession("ss-bs-plain", { employee: "backslash-owner", title: "plain bar fixture", lastActivity: "2026-07-05T12:01:00.000Z" });

    // `\bar` matches ONLY the row containing a literal backslash-b-a-r…
    expect(reg.searchSessionsFiltered({ text: "\\bar" }).map((s) => s.id)).toEqual(["ss-bs"]);
    // …a bare `\` matches only the backslash row…
    expect(reg.searchSessionsFiltered({ text: "\\" }).map((s) => s.id)).toEqual(["ss-bs"]);
    // …the full phrase matches…
    expect(reg.searchSessionsFiltered({ text: "literal backslash \\bar" }).map((s) => s.id)).toEqual(["ss-bs"]);
    // …and plain `bar` still matches both (ordinary substring).
    expect(reg.searchSessionsFiltered({ employee: "backslash-owner", text: "bar" }).map((s) => s.id).sort()).toEqual([
      "ss-bs",
      "ss-bs-plain",
    ]);
  });

  it("time-range filters compare ISO strings against last_activity", () => {
    const since = reg.searchSessionsFiltered({ employee: "adhoc-runner", activeSince: "2026-07-05T00:00:00.000Z" });
    expect(since.map((s) => s.id)).toEqual(["ss-d"]);
    expect(reg.searchSessionsFiltered({ employee: "adhoc-runner", activeBefore: "2026-07-05T00:00:00.000Z" })).toEqual([]);
    const before = reg.searchSessionsFiltered({ employee: "beta-writer", activeBefore: "2026-07-05T00:00:00.000Z" });
    expect(before.map((s) => s.id)).toEqual(["ss-c"]);
  });

  it("needsAttention is exactly status IN (error, interrupted) — waiting excluded (operator ruling)", () => {
    mkSession("ss-wait", { status: "waiting", engine: "grok", lastActivity: "2026-07-05T11:00:00.000Z" });
    const attn = reg.searchSessionsFiltered({ needsAttention: true });
    const ids = attn.map((s) => s.id);
    expect(ids).toContain("ss-b"); // error
    expect(ids).toContain("ss-c"); // interrupted
    expect(ids).not.toContain("ss-wait"); // waiting self-resolves
    expect(ids).not.toContain("ss-a"); // idle
  });

  it("respects the limit cap", () => {
    const limited = reg.searchSessionsFiltered({ engine: "codex" }, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe("ss-b"); // the newest codex session
  });
});

describe("cost report (GRS-020c cost-only)", () => {
  it("aggregates existing session accounting by employee and day with deterministic ordering", () => {
    mkSession("cost-employee-a", { employee: "alpha-cost", engine: "codex", createdAt: "2026-07-10T10:00:00.000Z" });
    mkSession("cost-employee-b", { employee: "beta-cost", engine: "claude", createdAt: "2026-07-11T10:00:00.000Z" });
    mkSession("cost-employee-c", { employee: null as never, engine: "codex", createdAt: "2026-07-11T11:00:00.000Z" });
    reg.accumulateSessionCost("cost-employee-a", 1.25, 3);
    reg.accumulateSessionCost("cost-employee-b", 2.5, 4);
    reg.accumulateSessionCost("cost-employee-c", 0.75, 2);

    const byEmployee = reg.getCostReport({ groupBy: "employee", since: "2026-07-10T00:00:00.000Z" });
    expect(byEmployee.rows).toEqual([
      { key: "beta-cost", cost: 2.5, turns: 4, sessions: 1 },
      { key: "alpha-cost", cost: 1.25, turns: 3, sessions: 1 },
      { key: "__unassigned__", cost: 0.75, turns: 2, sessions: 1 },
    ]);
    expect(byEmployee.total).toEqual({ cost: 4.5, turns: 9, sessions: 3 });

    const byDay = reg.getCostReport({ groupBy: "day", employee: "beta-cost" });
    expect(byDay.rows).toEqual([{ key: "2026-07-11", cost: 2.5, turns: 4, sessions: 1 }]);
    expect(byDay.total).toEqual({ cost: 2.5, turns: 4, sessions: 1 });
  });
});

describe("getMessageContext (GRS-020a)", () => {
  it("returns the ±radius window in order with the anchor flagged", () => {
    mkSession("ctx-a");
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(mkMessage("ctx-a", i % 2 ? "assistant" : "user", `wallaby step ${i}`, 6000 + i));

    const ctx = reg.getMessageContext("ctx-a", ids[4], 2);
    expect(ctx).toBeDefined();
    expect(ctx!.messages.map((m) => m.id)).toEqual([ids[2], ids[3], ids[4], ids[5], ids[6]]);
    expect(ctx!.messages.map((m) => m.isAnchor)).toEqual([false, false, true, false, false]);
    expect(ctx!.messages[2].content).toBe("wallaby step 4");
  });

  it("clamps the window at the history edges", () => {
    mkSession("ctx-edge");
    const ids = [0, 1, 2].map((i) => mkMessage("ctx-edge", "assistant", `edge ${i}`, 7000 + i));
    const atStart = reg.getMessageContext("ctx-edge", ids[0], 5);
    expect(atStart!.messages.map((m) => m.id)).toEqual(ids);
    expect(atStart!.messages[0].isAnchor).toBe(true);
  });

  it("returns each message body in full", () => {
    mkSession("ctx-cap");
    const long = "x".repeat(5000);
    const mid = mkMessage("ctx-cap", "assistant", long, 8000);
    const ctx = reg.getMessageContext("ctx-cap", mid, 1);
    expect(ctx!.messages[0].content).toBe(long);
    expect(ctx!.messages[0].content).not.toContain("…[truncated");
  });

  it("keeps getMessages ordering under timestamp ties (NULL seq vs numbered seq) — the bounded-window rewrite (finding 6)", () => {
    mkSession("ctx-tie");
    const db = dbModule.initDb();
    const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, seq) VALUES (?, ?, ?, ?, ?, ?)");
    // Same timestamp: NULL seq sorts before numbered seqs (getMessages: timestamp ASC, seq ASC).
    ins.run("tie-null", "ctx-tie", "assistant", "tie null", 9500, null);
    ins.run("tie-0", "ctx-tie", "assistant", "tie zero", 9500, 0);
    ins.run("tie-1", "ctx-tie", "assistant", "tie one", 9500, 1);
    ins.run("tie-late", "ctx-tie", "assistant", "later row", 9501, null);

    const around0 = reg.getMessageContext("ctx-tie", "tie-0", 1);
    expect(around0!.messages.map((m) => m.id)).toEqual(["tie-null", "tie-0", "tie-1"]);
    const aroundNull = reg.getMessageContext("ctx-tie", "tie-null", 2);
    expect(aroundNull!.messages.map((m) => m.id)).toEqual(["tie-null", "tie-0", "tie-1"]);
    const around1 = reg.getMessageContext("ctx-tie", "tie-1", 1);
    expect(around1!.messages.map((m) => m.id)).toEqual(["tie-0", "tie-1", "tie-late"]);
  });

  it("returns undefined for an unknown message id in an existing session", () => {
    mkSession("ctx-miss");
    mkMessage("ctx-miss", "assistant", "present", 9000);
    expect(reg.getMessageContext("ctx-miss", "no-such-message", 3)).toBeUndefined();
    // and a message id that exists but in ANOTHER session must not leak across
    const other = mkMessage("ctx-a", "assistant", "other-session row", 9100);
    expect(reg.getMessageContext("ctx-miss", other, 3)).toBeUndefined();
  });
});
