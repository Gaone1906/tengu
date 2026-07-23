import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  allocateWorkItemId,
  migrateWorkItemsSchema,
  useWorkItemAllocationClaim,
  verifyCurrentWorkItemSchema,
  WORK_ITEM_IDENTITY_TRIGGERS_DDL,
} from "../migrate.js";

function insertClaimedTodo(db: Database.Database, claim: ReturnType<typeof allocateWorkItemId>, title = "claimed"): void {
  useWorkItemAllocationClaim(db, claim, () => db.prepare(`
    INSERT INTO work_items (id, title, created_by, root_id, depth, created_at, updated_at)
    VALUES (?, ?, 'system', ?, 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
  `).run(claim.id, title, claim.id));
}

describe("the freshly created Todo schema", () => {
  it("keeps each prefix namespace monotonic and refuses direct prefix rewrites", () => {
    const db = new Database(":memory:");
    migrateWorkItemsSchema(db, "absent");

    const first = allocateWorkItemId(db, "2026-07-14T00:00:00.000Z", "ICI");
    const second = allocateWorkItemId(db, "2026-07-14T00:00:01.000Z", "ICI");
    const third = allocateWorkItemId(db, "2026-07-14T00:00:02.000Z", "ICI");

    expect(first.id).toBe("ICI-1");
    expect(second.id).toBe("ICI-2");
    expect(third.id).toBe("ICI-3");
    expect(db.prepare("SELECT prefix FROM work_item_id_allocator").pluck().all()).toEqual(["ICI"]);
    expect(() => db.prepare("UPDATE work_item_id_allocator SET prefix = 'ACM'").run()).toThrow(/allocator/i);
  });

  it("rejects a claimed insert whose prefix differs from the claimed namespace", () => {
    const db = new Database(":memory:");
    migrateWorkItemsSchema(db, "absent");
    const claim = allocateWorkItemId(db, "2026-07-14T00:00:00.000Z", "ICI");

    expect(() => useWorkItemAllocationClaim(db, claim, () => db.prepare(`
      INSERT INTO work_items (id, title, created_by, root_id, depth, created_at, updated_at)
      VALUES ('ACM-1', 'wrong company', 'system', 'ACM-1', 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `).run())).toThrow(/allocation claim/i);
  });

  it("satisfies its own verifier", () => {
    const db = new Database(":memory:");

    expect(() => migrateWorkItemsSchema(db, "absent")).not.toThrow();
    expect(() => verifyCurrentWorkItemSchema(db)).not.toThrow();
  });

  it("stores every identity trigger with a complete body", () => {
    const db = new Database(":memory:");
    try {
      migrateWorkItemsSchema(db, "absent");
    } catch {
      // The schema is written before verification; inspect what landed regardless.
    }

    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string; sql: string }>;

    expect(triggers.map((t) => t.name)).toContain("work_items_id_immutable");
    expect(triggers.map((t) => t.name)).toContain("work_items_mark_issued");
    for (const trigger of triggers) {
      expect(trigger.sql.trim()).toMatch(/END$/i);
    }
  });

  it("refuses a constraint-free replacement of an identity ledger table", () => {
    const db = new Database(":memory:");
    migrateWorkItemsSchema(db, "absent");
    db.exec(`
      DROP TABLE work_item_id_burns;
      CREATE TABLE work_item_id_burns (
        ordinal INTEGER PRIMARY KEY,
        claim_digest TEXT NOT NULL UNIQUE,
        burned_at TEXT NOT NULL
      );
      ${WORK_ITEM_IDENTITY_TRIGGERS_DDL}
    `);

    expect(() => verifyCurrentWorkItemSchema(db)).toThrow(/Unsupported prerelease Todo data/);
  });

  it("rejects unclaimed, unburned, and high-water-mismatched direct inserts", () => {
    const db = new Database(":memory:");
    migrateWorkItemsSchema(db, "absent");

    const insert = db.prepare(`
      INSERT INTO work_items (id, title, created_at, updated_at)
      VALUES (?, 'forged', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `);
    expect(() => insert.run("JIN-1")).toThrow(/allocation claim/i);

    const claim = allocateWorkItemId(db, "2026-07-14T00:00:00.000Z");
    expect(claim.id).toBe("JIN-1");
    expect(() => insert.run(claim.id)).toThrow(/allocation claim/i);
    expect(() => useWorkItemAllocationClaim(db, claim, () => insert.run("JIN-2"))).toThrow(/allocation claim/i);
    expect(db.prepare("SELECT COUNT(*) FROM work_items").pluck().get()).toBe(0);
  });

  it("permanently burns abandoned allocations and never reuses a deleted id", () => {
    const db = new Database(":memory:");
    migrateWorkItemsSchema(db, "absent");

    const abandoned = allocateWorkItemId(db, "2026-07-14T00:00:00.000Z");
    const issued = allocateWorkItemId(db, "2026-07-14T00:00:01.000Z");
    expect([abandoned.id, issued.id]).toEqual(["JIN-1", "JIN-2"]);
    insertClaimedTodo(db, issued);
    expect(db.prepare("SELECT ordinal FROM work_item_id_issuances ORDER BY ordinal").pluck().all()).toEqual([2]);

    db.prepare("DELETE FROM work_items WHERE id = ?").run(issued.id);
    expect(() => insertClaimedTodo(db, issued, "reused")).toThrow(/allocation claim/i);
    expect(db.prepare("SELECT ordinal FROM work_item_id_burns ORDER BY ordinal").pluck().all()).toEqual([1, 2]);
    expect(db.prepare("SELECT ordinal FROM work_item_id_issuances ORDER BY ordinal").pluck().all()).toEqual([2]);
  });

  it("makes allocator, burn, and issuance evidence append-only outside the allocator", () => {
    const db = new Database(":memory:");
    migrateWorkItemsSchema(db, "absent");
    const claim = allocateWorkItemId(db, "2026-07-14T00:00:00.000Z");
    insertClaimedTodo(db, claim);

    expect(() => db.exec("UPDATE work_item_id_allocator SET high_water = 0")).toThrow(/allocator/i);
    expect(() => db.exec("DELETE FROM work_item_id_allocator")).toThrow(/allocator/i);
    expect(() => db.exec("INSERT INTO work_item_id_allocator (prefix, high_water) VALUES ('ZZZ', 2)")).toThrow();
    expect(() => db.exec("UPDATE work_item_id_burns SET burned_at = 'changed'")).toThrow(/append-only/i);
    expect(() => db.exec("DELETE FROM work_item_id_burns")).toThrow(/append-only/i);
    expect(() => db.exec("UPDATE work_item_id_issuances SET issued_at = 'changed'")).toThrow(/append-only/i);
    expect(() => db.exec("DELETE FROM work_item_id_issuances")).toThrow(/append-only/i);
    expect(() => verifyCurrentWorkItemSchema(db)).not.toThrow();
  });
});
