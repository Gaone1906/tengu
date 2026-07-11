import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateActivitySchema } from "../migrate.js";
import { ActivityQueryError, getActivityStory, queryActivityPage } from "../query.js";
import { appendActivityEvent } from "../store.js";
import type { ActivityEventInput, ActivityKind, ActivityOutcomeState } from "../types.js";

const NOW = new Date("2026-07-11T20:00:00.000Z");

function memoryDb(): Database.Database {
  const database = new Database(":memory:");
  migrateActivitySchema(database);
  return database;
}

function fixture(index: number, overrides: Partial<ActivityEventInput> = {}): ActivityEventInput {
  const objectId = overrides.object?.id ?? `object-${index}`;
  return {
    occurredAt: "2026-07-11T12:00:00.000Z",
    kind: "session",
    action: "session.completed",
    actor: { type: "employee", id: `employee-${index % 4}`, displayName: `Employee ${index % 4}` },
    object: { type: "session", id: objectId, label: `Session ${index}`, href: `/?session=${objectId}` },
    outcome: { state: "succeeded", label: "Completed" },
    summary: `Employee ${index % 4} completed Session ${index}`,
    correlationId: `session:run:${index}`,
    idempotencyKey: `session:completed:event-${index}`,
    detail: { index },
    ...overrides,
  };
}

function idFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

describe("Activity query", () => {
  it("paginates more than 1,100 equal-timestamp stories without gaps or duplicates and reports honest totals", () => {
    const database = memoryDb();
    for (let index = 0; index < 1_105; index++) {
      appendActivityEvent(fixture(index), { database, idFactory: () => idFor(index) });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = queryActivityPage({ limit: 73, cursor }, { database, now: () => NOW });
      expect(result.totals.matching).toBe(1_105);
      expect(result.totals.total).toBe(1_105);
      expect(result.asOf).toBe(NOW.toISOString());
      seen.push(...result.items.map((story) => story.id));
      cursor = result.page.nextCursor ?? undefined;
      if (!result.page.hasMore) expect(cursor).toBeUndefined();
    } while (cursor);

    expect(seen).toHaveLength(1_105);
    expect(new Set(seen).size).toBe(1_105);
  });

  it("freezes a cursor walk at its first-page append sequence while a fresh query sees later appends", () => {
    const database = memoryDb();
    for (let index = 0; index < 5; index++) appendActivityEvent(fixture(index), { database, idFactory: () => idFor(index) });

    const first = queryActivityPage({ limit: 2 }, { database, now: () => NOW });
    appendActivityEvent(fixture(10, { occurredAt: "2026-07-11T19:00:00.000Z" }), { database, idFactory: () => idFor(10) });
    appendActivityEvent(fixture(11, { occurredAt: "2026-07-10T01:00:00.000Z" }), { database, idFactory: () => idFor(11) });

    const remainder = queryActivityPage({ limit: 10, cursor: first.page.nextCursor! }, { database, now: () => NOW });
    expect([...first.items, ...remainder.items]).toHaveLength(5);
    expect(remainder.totals.total).toBe(5);
    expect(queryActivityPage({ limit: 10 }, { database, now: () => NOW }).totals.total).toBe(7);
  });

  it("applies server-side search, kind/outcome filters, and totals over the same matching story set", () => {
    const database = memoryDb();
    const rows: Array<[ActivityKind, ActivityOutcomeState, string]> = [
      ["todo", "attention", "Преглед на договор"],
      ["todo", "failed", "Release check failed"],
      ["workflow", "failed", "Release workflow failed"],
      ["workflow", "succeeded", "Release workflow completed"],
      ["system", "info", "Configuration reloaded"],
    ];
    rows.forEach(([kind, state, summary], index) => appendActivityEvent(fixture(index, {
      kind,
      outcome: { state, label: state },
      summary,
      occurredAt: index === 4 ? "2026-07-10T23:59:59.000Z" : fixture(index).occurredAt,
    }), { database, idFactory: () => idFor(index) }));

    const failed = queryActivityPage({ limit: 20, kinds: ["todo", "workflow"], outcomes: ["failed"], q: "Release" }, { database, now: () => NOW });
    expect(failed.items).toHaveLength(2);
    expect(failed.totals).toMatchObject({ matching: 2, total: 5, today: 4, attention: 1, failed: 2 });
    expect(failed.totals.byKind).toEqual({ todo: 1, workflow: 1 });
    expect(failed.totals.byOutcome).toEqual({ failed: 2 });

    const unicode = queryActivityPage({ limit: 20, q: "договор" }, { database, now: () => NOW });
    expect(unicode.items.map((item) => item.headline)).toEqual(["Преглед на договор"]);
    expect(unicode.totals.matching).toBe(1);
  });

  it("uses locale-neutral NFKD casefold search for Bulgarian, accented Latin, Greek, and Turkish text", () => {
    const database = memoryDb();
    const cases = [
      ["ПРЕГЛЕД НА ДОГОВОР", "преглед на договор"],
      ["Café résumé", "CAFE RESUME"],
      ["ΟΔΥΣΣΕΎΣ", "οδυσσευσ"],
      ["İSTANBUL IĞDIR ıslak", "istanbul igdir islak"],
    ] as const;
    cases.forEach(([summary], index) => appendActivityEvent(fixture(index, { summary }), {
      database,
      idFactory: () => idFor(index),
    }));

    cases.forEach(([summary, query]) => {
      const result = queryActivityPage({ q: query }, { database, now: () => NOW });
      expect(result.items.map((story) => story.headline), query).toEqual([summary]);
    });
  });

  it("establishes current story state before kind/outcome filters while retaining historical search matches", () => {
    const database = memoryDb();
    appendActivityEvent(fixture(1, {
      occurredAt: "2026-07-11T12:00:00.000Z",
      outcome: { state: "failed", label: "Failed" },
      summary: "transient-only-marker failed",
      correlationId: "session:recovery:one",
      idempotencyKey: "session:failed:recovery-one",
    }), { database, idFactory: () => idFor(1) });
    appendActivityEvent(fixture(2, {
      occurredAt: "2026-07-11T12:01:00.000Z",
      outcome: { state: "succeeded", label: "Recovered" },
      summary: "Session recovered",
      correlationId: "session:recovery:one",
      idempotencyKey: "session:recovered:recovery-one",
    }), { database, idFactory: () => idFor(2) });

    expect(queryActivityPage({ outcomes: ["failed"] }, { database, now: () => NOW }).items).toEqual([]);
    expect(queryActivityPage({ outcomes: ["succeeded"] }, { database, now: () => NOW }).items).toHaveLength(1);
    const historical = queryActivityPage({ q: "transient-only-marker" }, { database, now: () => NOW });
    expect(historical.items).toHaveLength(1);
    expect(historical.items[0]?.headline).toBe("Session recovered");
    expect(historical.items[0]?.outcome.state).toBe("succeeded");
  });

  it("separates identical source-local correlations across domains and joins only an explicit namespaced causal root", () => {
    const database = memoryDb();
    appendActivityEvent(fixture(1, {
      kind: "todo",
      correlationId: "source:local:collision-one",
      idempotencyKey: "todo:event:collision-one",
    }), { database, idFactory: () => idFor(1) });
    appendActivityEvent(fixture(2, {
      kind: "workflow",
      correlationId: "source:local:collision-one",
      idempotencyKey: "workflow:event:collision-one",
    }), { database, idFactory: () => idFor(2) });

    const separated = queryActivityPage({}, { database, now: () => NOW });
    expect(separated.items).toHaveLength(2);
    expect(new Set(separated.items.map((story) => story.id)).size).toBe(2);

    appendActivityEvent(fixture(3, {
      kind: "todo",
      correlationId: "todo:local:shared-root",
      rootEventId: "root:operation:shared-one",
      idempotencyKey: "todo:event:shared-root",
    }), { database, idFactory: () => idFor(3) });
    appendActivityEvent(fixture(4, {
      kind: "workflow",
      correlationId: "workflow:local:shared-root",
      rootEventId: "root:operation:shared-one",
      idempotencyKey: "workflow:event:shared-root",
    }), { database, idFactory: () => idFor(4) });

    const joined = queryActivityPage({}, { database, now: () => NOW });
    expect(joined.items).toHaveLength(3);
    expect(joined.items.find((story) => story.eventCount === 2)).toBeDefined();
  });

  it("groups only explicit correlation, keeps concurrent same-object stories separate, and returns the redacted causal spine", () => {
    const database = memoryDb();
    const sharedObject = { type: "todo", id: "shared-object", label: "Shared Todo", href: "/todos?item=shared-object" };
    appendActivityEvent(fixture(1, {
      kind: "approval",
      action: "approval.requested",
      object: sharedObject,
      correlationId: "approval:attempt:one",
      outcome: { state: "attention", label: "Waiting" },
      summary: "Approval requested",
      detail: { token: "private-value", note: "first" },
      links: [{ rel: "todo", label: "Open Todo", href: sharedObject.href }],
    }), { database, idFactory: () => idFor(1) });
    appendActivityEvent(fixture(2, {
      occurredAt: "2026-07-11T12:01:00.000Z",
      kind: "approval",
      action: "approval.decided",
      object: sharedObject,
      correlationId: "approval:attempt:one",
      causationId: "event-one",
      outcome: { state: "succeeded", label: "Approved" },
      summary: "Approval granted",
      links: [{ rel: "todo", label: "Open Todo", href: sharedObject.href }],
    }), { database, idFactory: () => idFor(2) });
    appendActivityEvent(fixture(3, {
      kind: "approval",
      object: sharedObject,
      correlationId: "approval:attempt:two",
      summary: "Concurrent approval requested",
    }), { database, idFactory: () => idFor(3) });

    const page = queryActivityPage({ limit: 20 }, { database, now: () => NOW });
    expect(page.items).toHaveLength(2);
    const grouped = page.items.find((story) => story.eventCount === 2)!;
    expect(grouped.headline).toBe("Approval granted");
    expect(grouped.preview).toHaveLength(2);

    const detail = getActivityStory(grouped.id, { database });
    expect(detail?.events.map((event) => event.action)).toEqual(["approval.requested", "approval.decided"]);
    expect(detail?.links).toEqual([{ rel: "todo", label: "Open Todo", href: "/todos?item=shared-object" }]);
    expect(JSON.stringify(detail)).not.toContain("private-value");
    expect(JSON.stringify(detail)).toContain("[REDACTED]");
  });

  it("rejects malformed cursors and invalid filters instead of silently returning an empty page", () => {
    const database = memoryDb();
    expect(() => queryActivityPage({ cursor: "not-a-cursor" }, { database })).toThrow(ActivityQueryError);
    expect(() => queryActivityPage({ kinds: ["invalid" as ActivityKind] }, { database })).toThrow(/kind/i);
    expect(() => queryActivityPage({ outcomes: ["unknown" as ActivityOutcomeState] }, { database })).toThrow(/outcome/i);
  });

  it("HMAC-authenticates every cursor field and byte and accepts an untampered cursor after database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "activity-cursor-"));
    const path = join(directory, "ledger.db");
    try {
      let database = new Database(path);
      migrateActivitySchema(database);
      for (let index = 0; index < 4; index++) appendActivityEvent(fixture(index), { database, idFactory: () => idFor(index) });
      const first = queryActivityPage({ limit: 2 }, { database, now: () => NOW });
      const cursor = first.page.nextCursor!;
      const [encodedPayload, signature, extra] = cursor.split(".");
      expect(encodedPayload).toBeTruthy();
      expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(extra).toBeUndefined();

      const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<string, unknown>;
      for (const field of Object.keys(payload)) {
        const changed = { ...payload, [field]: typeof payload[field] === "number" ? Number(payload[field]) + 1 : `${String(payload[field])}x` };
        const tampered = `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
        expect(() => queryActivityPage({ limit: 2, cursor: tampered }, { database, now: () => NOW })).toThrow(ActivityQueryError);
      }
      for (let index = 0; index < cursor.length; index++) {
        const replacement = cursor[index] === "A" ? "B" : "A";
        const tampered = cursor.slice(0, index) + replacement + cursor.slice(index + 1);
        expect(() => queryActivityPage({ limit: 2, cursor: tampered }, { database, now: () => NOW })).toThrow(ActivityQueryError);
      }

      database.close();
      database = new Database(path);
      migrateActivitySchema(database);
      expect(queryActivityPage({ limit: 2, cursor }, { database, now: () => NOW }).items).toHaveLength(2);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
