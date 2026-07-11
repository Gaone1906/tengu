import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateActivitySchema } from "../migrate.js";
import { appendActivityEvent } from "../store.js";
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
    rootEventId: "source-root-1",
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

  it("returns the original event for an idempotent retry without consuming another append sequence", () => {
    const database = memoryDb();
    const original = appendActivityEvent(input(), {
      database,
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });
    const replay = appendActivityEvent(input({ summary: "A retry must not overwrite immutable data" }), {
      database,
      idFactory: () => "00000000-0000-4000-8000-000000000002",
    });

    expect(replay).toEqual({ inserted: false, event: original.event });
    expect(database.prepare("SELECT COUNT(*) AS n FROM activity_events").get()).toEqual({ n: 1 });
    expect(database.prepare("SELECT MAX(seq) AS n FROM activity_events").get()).toEqual({ n: 1 });
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

  it("rejects malformed timestamps, blank causal keys, unsafe links, and non-namespaced idempotency keys", () => {
    const database = memoryDb();
    expect(() => appendActivityEvent(input({ occurredAt: "yesterday" }), { database })).toThrow(/occurredAt/i);
    expect(() => appendActivityEvent(input({ correlationId: " " }), { database })).toThrow(/correlationId/i);
    expect(() => appendActivityEvent(input({ idempotencyKey: "retry" }), { database })).toThrow(/namespaced/i);
    expect(() => appendActivityEvent(input({ object: { type: "todo", id: "x", label: "x", href: "https://evil.example/x" } }), { database })).toThrow(/href/i);
  });
});
