import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-v2-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../migrate.js");
let migrate: Migrate;

beforeAll(async () => {
  migrate = await import("../migrate.js");
});

/** Build a real v1 database: v1 tables, v1 triggers, one allocated item ACM-1
 *  and a burned-but-unissued gap at ordinal 2 (idempotency-race artifact). */
function buildV1Fixture(file: string): void {
  const db = new Database(file);
  db.exec(migrate.V1_WORK_ITEMS_TABLE_DDL);
  db.exec(migrate.V1_WORK_ITEM_IDENTITY_TABLES_DDL);
  db.exec(migrate.WORK_ITEM_EVENTS_DDL);
  db.exec(migrate.WORK_ITEM_EDIT_RECEIPTS_DDL);
  db.exec(migrate.V1_WORK_ITEM_IDENTITY_TRIGGERS_DDL);
  migrate.registerWorkItemIdentityFunctions(db);
  const now = "2026-07-01T00:00:00.000Z";
  const claim1 = migrate.allocateWorkItemIdV1ForTest(db, now, "Acme Corp");
  migrate.useWorkItemAllocationClaim(db, claim1, () => {
    db.prepare(
      `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_at, updated_at)
       VALUES (?, 'seed item', 'backlog', 2, 1, 'human', 0, ?, ?)`,
    ).run(claim1.id, now, now);
  });
  migrate.allocateWorkItemIdV1ForTest(db, now, "Acme Corp"); // burn ordinal 2, never issue
  db.close();
}

describe("v1 → v2 migration", () => {
  it("classifies a v1 database as 'v1', rebuilds to v2, preserves data and allocator continuity, and is idempotent", () => {
    const file = path.join(tmp, "registry-migrate.db");
    buildV1Fixture(file);
    expect(migrate.preflightWorkItemsDatabase(file)).toBe("v1");

    const db = new Database(file);
    migrate.registerWorkItemIdentityFunctions(db);
    const first = migrate.migrateWorkItemsSchema(db, "v1");
    expect(first.rebuilt).toBe(true);

    // v2 shape verifies clean
    migrate.verifyCurrentWorkItemSchema(db);

    // row survived with backfill
    const row = db.prepare("SELECT * FROM work_items WHERE id = 'ACM-1'").get() as Record<string, unknown>;
    expect(row.title).toBe("seed item");
    expect(row.created_by).toBe("operator"); // source=human → operator
    expect(row.root_id).toBe("ACM-1");
    expect(row.depth).toBe(0);
    expect(row.parent_id).toBeNull();

    // allocator became per-prefix and kept the high-water (2: one issued + one gap)
    const alloc = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator").all() as Array<{ prefix: string; high_water: number }>;
    expect(alloc).toEqual([{ prefix: "ACM", high_water: 2 }]);
    const burns = db.prepare("SELECT prefix, ordinal FROM work_item_id_burns ORDER BY ordinal").all();
    expect(burns).toEqual([{ prefix: "ACM", ordinal: 1 }, { prefix: "ACM", ordinal: 2 }]);

    // next mint continues the sequence
    const claim = migrate.allocateWorkItemId(db, "2026-07-02T00:00:00.000Z", "ACM");
    expect(claim.id).toBe("ACM-3");

    // idempotent: running again is a no-op
    const second = migrate.migrateWorkItemsSchema(db);
    expect(second.rebuilt).toBe(false);
    db.close();
    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");
  });

  it("allocates independent sequences per prefix", () => {
    const file = path.join(tmp, "registry-prefix.db");
    const db = new Database(file);
    migrate.registerWorkItemIdentityFunctions(db);
    migrate.migrateWorkItemsSchema(db, "absent");
    expect(migrate.allocateWorkItemId(db, "2026-07-01T00:00:00.000Z", "ACM").id).toBe("ACM-1");
    expect(migrate.allocateWorkItemId(db, "2026-07-01T00:00:00.000Z", "PLA").id).toBe("PLA-1");
    expect(migrate.allocateWorkItemId(db, "2026-07-01T00:00:00.000Z", "ACM").id).toBe("ACM-2");
    db.close();
  });
});
