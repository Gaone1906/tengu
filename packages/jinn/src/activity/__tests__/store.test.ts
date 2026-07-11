import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateActivitySchema } from "../migrate.js";
import {
  ActivityCorruptionError,
  ActivityIdempotencyConflictError,
  ActivityValidationError,
  activityEventFromRow,
  appendActivityEvent,
  type ActivityRow,
} from "../store.js";
import type { ActivityEventInput } from "../types.js";

function input(overrides: Partial<ActivityEventInput> = {}): ActivityEventInput {
  return {
    occurredAt: "2026-07-11T12:00:00.000Z",
    kind: "todo",
    action: "approval.requested",
    actor: { type: "employee", id: "operations-lead", displayName: "Operations Lead" },
    object: { type: "todo", id: "domain-object-123", label: "Release check", href: "/todos?item=domain-object-123" },
    outcome: { state: "attention", label: "Waiting for a decision" },
    summary: "Operations Lead requested approval for Release check",
    correlationId: "todo:domain-object-123:approval:attempt-1",
    causationId: "source-event-1",
    attempt: 1,
    idempotencyKey: "todo:approval-requested:source-event-1",
    detailRef: "work-item-event:source-event-1",
    detail: { request: "Ship after checks", nested: { apiKey: "sk-testvalue1234" } },
    links: [{ rel: "todo", label: "Open Todo", href: "/todos?item=domain-object-123" }],
    ...overrides,
  };
}

function memoryDb(): Database.Database {
  const database = new Database(":memory:");
  migrateActivitySchema(database);
  return database;
}

describe("ActivityStore", () => {
  it("migrates idempotently and appends an immutable normalized event with opaque ledger IDs", () => {
    const database = memoryDb();
    expect(() => migrateActivitySchema(database)).not.toThrow();

    const first = appendActivityEvent(input(), {
      database,
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });

    expect(first.inserted).toBe(true);
    expect(first.event).toMatchObject({
      id: "act_00000000-0000-4000-8000-000000000001",
      storyId: expect.stringMatching(/^story_[a-f0-9]{24}$/),
      correlationId: "todo:domain-object-123:approval:attempt-1",
      object: { id: "domain-object-123" },
      attempt: 1,
    });
    expect(first.event.id).not.toContain("domain-object-123");
    expect(first.event.storyId).not.toContain("domain-object-123");

    expect(() => database.prepare("UPDATE activity_events SET summary = 'changed' WHERE id = ?").run(first.event.id)).toThrow(/immutable/i);
    expect(() => database.prepare("DELETE FROM activity_events WHERE id = ?").run(first.event.id)).toThrow(/immutable/i);
  });

  it("returns the original event only for an exact normalized idempotent replay", () => {
    const database = memoryDb();
    const original = appendActivityEvent(input(), {
      database,
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });
    const replay = appendActivityEvent(input(), {
      database,
      idFactory: () => "00000000-0000-4000-8000-000000000002",
    });

    expect(replay).toEqual({ inserted: false, event: original.event });
    expect(database.prepare("SELECT COUNT(*) AS n FROM activity_events").get()).toEqual({ n: 1 });
    expect(database.prepare("SELECT MAX(seq) AS n FROM activity_events").get()).toEqual({ n: 1 });
  });

  it("raises a typed, non-sensitive conflict when any persisted field differs for an idempotency key", () => {
    const database = memoryDb();
    appendActivityEvent(input(), { database });

    for (const changed of [
      input({ occurredAt: "2026-07-11T12:00:01.000Z" }),
      input({ kind: "approval" }),
      input({ action: "approval.changed" }),
      input({ summary: "different summary" }),
      input({ actor: { type: "employee", id: "another-actor", displayName: "Another Actor" } }),
      input({ actor: { type: "system", id: "operations-lead", displayName: "Operations Lead" } }),
      input({ actor: { type: "employee", id: "operations-lead", displayName: "Another Actor" } }),
      input({ object: { type: "approval", id: "domain-object-123", label: "Release check", href: "/todos?item=domain-object-123" } }),
      input({ object: { type: "todo", id: "another-object", label: "Release check", href: "/todos?item=domain-object-123" } }),
      input({ object: { type: "todo", id: "domain-object-123", label: "Another label", href: "/todos?item=domain-object-123" } }),
      input({ object: { type: "todo", id: "domain-object-123", label: "Release check", href: "/todos?item=another" } }),
      input({ outcome: { state: "failed", label: "Waiting for a decision" } }),
      input({ outcome: { state: "attention", label: "Another outcome" } }),
      input({ correlationId: "todo:domain-object-123:approval:attempt-2" }),
      input({ causationId: "source-event-2" }),
      input({ rootEventId: "root:todo:source-root-2" }),
      input({ attempt: 2 }),
      input({ detailRef: "work-item-event:source-event-2" }),
      input({ detail: { request: "different detail" } }),
      input({ links: [{ rel: "todo", label: "Different label", href: "/todos?item=domain-object-123" }] }),
    ]) {
      let error: unknown;
      try {
        appendActivityEvent(changed, { database });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ActivityIdempotencyConflictError);
      expect(String(error)).not.toContain("different");
      expect(String(error)).not.toContain("another-actor");
    }
    expect(database.prepare("SELECT COUNT(*) AS n FROM activity_events").get()).toEqual({ n: 1 });
  });

  it("blocks INSERT OR REPLACE by event ID and idempotency key at the database boundary", () => {
    const database = memoryDb();
    const original = appendActivityEvent(input(), {
      database,
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });
    const before = database.prepare("SELECT * FROM activity_events WHERE id = ?").get(original.event.id);

    expect(() => database.prepare(`
      INSERT OR REPLACE INTO activity_events
      SELECT * FROM activity_events WHERE id = ?
    `).run(original.event.id)).toThrow(/immutable|already exists/i);

    const columns = database.prepare("PRAGMA table_info(activity_events)").all() as Array<{ name: string }>;
    const insertColumns = columns.map(({ name }) => name).filter((name) => name !== "seq");
    const selections = insertColumns.map((name) => name === "id"
      ? "'act_00000000-0000-4000-8000-000000000002' AS id"
      : `"${name}"`);
    expect(() => database.prepare(`
      INSERT OR REPLACE INTO activity_events (${insertColumns.map((name) => `"${name}"`).join(",")})
      SELECT ${selections.join(",")} FROM activity_events WHERE id = ?
    `).run(original.event.id)).toThrow(/immutable|idempotency|already exists/i);

    expect(database.prepare("SELECT * FROM activity_events WHERE id = ?").get(original.event.id)).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) AS n, MAX(seq) AS max_seq FROM activity_events").get()).toEqual({ n: 1, max_seq: 1 });
  });

  it("derives one stable story ID from explicit correlation and never groups by object or timestamp", () => {
    const database = memoryDb();
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    const correlatedA = appendActivityEvent(input({ idempotencyKey: "event:append:a" }), { database, idFactory: () => ids.shift()! }).event;
    const correlatedB = appendActivityEvent(input({ action: "approval.decided", idempotencyKey: "event:append:b" }), { database, idFactory: () => ids.shift()! }).event;
    const concurrent = appendActivityEvent(input({ correlationId: "todo:domain-object-123:approval:attempt-2", idempotencyKey: "event:append:c" }), { database, idFactory: () => ids.shift()! }).event;

    expect(correlatedB.storyId).toBe(correlatedA.storyId);
    expect(concurrent.storyId).not.toBe(correlatedA.storyId);
  });

  it("redacts secrets, credential text, and private home paths before any value reaches SQLite", () => {
    const database = memoryDb();
    appendActivityEvent(input({
      summary: "Authorization: Bearer private-token-value at /home/private-user/project",
      actor: { type: "employee", id: "employee-a", displayName: "Owner /home/private-user" },
      object: { type: "session", id: "session-a", label: "Key sk-testvalue1234" },
      detailRef: "/home/private-user/evidence.json",
      detail: {
        password: "open-sesame",
        nested: { note: "Authorization: Basic private-basic-value", safe: "kept" },
      },
    }), { database });

    const serialized = JSON.stringify(database.prepare("SELECT * FROM activity_events").get());
    expect(serialized).not.toContain("private-token-value");
    expect(serialized).not.toContain("private-basic-value");
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("open-sesame");
    expect(serialized).not.toContain("sk-testvalue1234");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("kept");
  });

  it("recursively redacts contextual credentials, JWTs, cloud keys, query values, errors, stacks, and paths in every string", () => {
    const database = memoryDb();
    const privateMacPath = ["", "Users", "private-home-name", "project", "file.ts"].join("/");
    const secrets = [
      "prose-password-value",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature-value",
      "AKIAABCDEFGHIJKLMNOP",
      "query-access-value",
      "error-secret-value",
      "private-home-name",
      "database-password-value",
    ];
    appendActivityEvent(input({
      action: "password is prose-password-value",
      actor: { type: "employee", id: "employee-a", displayName: `JWT ${secrets[1]}` },
      object: { type: "session", id: "session-a", label: `cloud ${secrets[2]}`, href: "/sessions?access_token=query-access-value" },
      outcome: { state: "failed", label: "Error: client_secret=error-secret-value" },
      summary: "postgres://service:database-password-value@db.invalid/app",
      detailRef: privateMacPath,
      detail: {
        message: "credential: prose-password-value",
        error: "Error: api_key=error-secret-value",
        stack: "at run (/home/private-home-name/project/file.ts:1:1)",
        values: [
          "password is prose-password-value",
          secrets[1],
          secrets[2],
          "https://example.invalid/?access_token=query-access-value",
          "Error: client_secret=error-secret-value",
          privateMacPath,
          "postgres://service:database-password-value@db.invalid/app",
        ],
      },
      links: [{ rel: "trace", label: "token: query-access-value", href: "/trace?token=query-access-value" }],
    }), { database });

    const rawDatabase = database.serialize().toString("utf8");
    for (const secret of secrets) expect(rawDatabase).not.toContain(secret);
    expect(rawDatabase).not.toContain("private-home-name");
    expect(rawDatabase).toContain("[REDACTED");
  });

  it("enforces explicit traversal, byte, collection, depth, and cycle limits before serialization", () => {
    const database = memoryDb();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: Record<string, unknown> = { value: "end" };
    for (let index = 0; index < 40; index++) deep = { nested: deep };

    for (const detail of [
      { oversized: "x".repeat(70_000) },
      { excessive: Array.from({ length: 10_001 }, (_, index) => index) },
      { invalidNumber: Number.NaN },
      { invalidValue: undefined },
      { invalidObject: new Date("2026-07-11T12:00:00.000Z") },
      deep,
      cycle,
    ]) {
      expect(() => appendActivityEvent(input({ detail: detail as never }), { database })).toThrow(ActivityValidationError);
    }
    expect(() => appendActivityEvent(input({
      links: Array.from({ length: 33 }, (_, index) => ({ rel: "item", label: `Item ${index}`, href: `/items/${index}` })),
    }), { database })).toThrow(ActivityValidationError);
    expect(database.prepare("SELECT COUNT(*) AS n FROM activity_events").get()).toEqual({ n: 0 });
  });

  it("reports malformed persisted JSON as a controlled non-sensitive corruption error", () => {
    const row = {
      seq: 1,
      id: "act_00000000-0000-4000-8000-000000000001",
      story_id: "story_000000000000000000000000",
      occurred_at: "2026-07-11T12:00:00.000Z",
      kind: "todo",
      action: "todo.updated",
      actor_type: "system",
      actor_id: "system",
      actor_display_name: "System",
      object_type: "todo",
      object_id: "opaque-object",
      object_label: "Todo",
      object_href: null,
      outcome_state: "info",
      outcome_label: "Updated",
      summary: "Updated",
      correlation_id: "todo:update:opaque-object",
      causation_id: null,
      root_event_id: null,
      attempt: null,
      idempotency_key: null,
      detail_ref: null,
      detail_json: "{private-corruption",
      links_json: null,
      payload_hash: "0".repeat(64),
    } satisfies ActivityRow;
    let error: unknown;
    try {
      activityEventFromRow(row);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ActivityCorruptionError);
    expect(String(error)).not.toContain("private-corruption");
  });

  it("rejects malformed timestamps, blank causal keys, unsafe links, and non-namespaced idempotency keys", () => {
    const database = memoryDb();
    expect(() => appendActivityEvent(input({ occurredAt: "yesterday" }), { database })).toThrow(/occurredAt/i);
    expect(() => appendActivityEvent(input({ correlationId: " " }), { database })).toThrow(/correlationId/i);
    expect(() => appendActivityEvent(input({ correlationId: "source-local" }), { database })).toThrow(/namespaced/i);
    expect(() => appendActivityEvent(input({ rootEventId: "source-local" }), { database })).toThrow(/causal root|rootEventId|namespaced/i);
    expect(() => appendActivityEvent(input({ idempotencyKey: "retry" }), { database })).toThrow(/namespaced/i);
    expect(() => appendActivityEvent(input({ object: { type: "todo", id: "x", label: "x", href: "https://evil.example/x" } }), { database })).toThrow(/href/i);
  });
});
