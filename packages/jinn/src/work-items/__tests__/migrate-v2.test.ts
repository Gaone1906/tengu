import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
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

  it("refuses a claimed burn for an unregistered prefix (NULL-subquery bypass closed)", () => {
    const file = path.join(tmp, "registry-burnguard.db");
    const db = new Database(file);
    migrate.registerWorkItemIdentityFunctions(db);
    migrate.migrateWorkItemsSchema(db, "absent");
    // An active, digest-valid claim for a prefix with NO allocator row: the
    // ordinal-sequence subquery returns NULL, which must still refuse the burn.
    const rawClaim = "ab".repeat(32);
    const digest = createHash("sha256").update(rawClaim).digest("hex");
    const forged = { id: "ZZZ-1", prefix: "ZZZ", ordinal: 1, rawClaim };
    expect(() =>
      migrate.useWorkItemAllocationClaim(db, forged, () =>
        db.prepare(
          "INSERT INTO work_item_id_burns (prefix, ordinal, claim_digest, burned_at) VALUES ('ZZZ', 1, ?, '2026-07-01T00:00:00.000Z')",
        ).run(digest),
      ),
    ).toThrow(/burn claim refused/);
    expect(db.prepare("SELECT COUNT(*) FROM work_item_id_burns").pluck().get()).toBe(0);
    db.close();
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

/* ── Todos v2 slice 4: work_item_approvals backfill + self-heal + verifier ──── */

function freshV2(file: string): Database.Database {
  const fresh = new Database(file);
  migrate.registerWorkItemIdentityFunctions(fresh);
  migrate.migrateWorkItemsSchema(fresh, "absent");
  return fresh;
}

function seedItemWithColumns(
  fresh: Database.Database,
  approval: Record<string, string | null> | null,
): string {
  const base = "2026-07-01T00:00:00.000Z";
  const claim = migrate.allocateWorkItemId(fresh, base, "ACM");
  migrate.useWorkItemAllocationClaim(fresh, claim, () => {
    fresh.prepare(
      `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
       VALUES (?, 'legacy approval carrier', 'in_review', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
    ).run(claim.id, claim.id, base, base);
  });
  if (approval) {
    fresh.prepare(
      `UPDATE work_items SET approval_state = @state, approval_request = @request, approval_ref = @ref,
         approval_target = @target, approval_target_kind = @target_kind, approval_escalated_at = @escalated_at,
         approval_decided_by = @decided_by, approval_decided_at = @decided_at
       WHERE id = @id`,
    ).run({
      state: null, request: null, ref: null, target: null, target_kind: null,
      escalated_at: null, decided_by: null, decided_at: null,
      ...approval,
      id: claim.id,
    });
  }
  return claim.id;
}

describe("work_item_approvals backfill", () => {
  it("copies pending/decided/escalated column values into exactly one row per item, skips NULL items, and is idempotent", () => {
    const file = path.join(tmp, "registry-backfill.db");
    const db = freshV2(file);
    const pendingId = seedItemWithColumns(db, {
      state: "pending", request: "legacy pending gate", ref: "workflow-gate:old:run:g",
      target: "coo", target_kind: "employee",
    });
    const decidedId = seedItemWithColumns(db, {
      state: "approved", request: "legacy decided gate", target: "coo", target_kind: "employee",
      escalated_at: "2026-07-02T00:00:00.000Z", decided_by: "operator", decided_at: "2026-07-03T00:00:00.000Z",
    });
    const plainId = seedItemWithColumns(db, null);

    const first = migrate.backfillWorkItemApprovals(db);
    expect(first).toBe(2);

    const rows = db
      .prepare("SELECT * FROM work_item_approvals ORDER BY work_item_id")
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    const pendingRow = rows.find((r) => r.work_item_id === pendingId)!;
    expect(pendingRow.state).toBe("pending");
    expect(pendingRow.request).toBe("legacy pending gate");
    expect(pendingRow.ref).toBe("workflow-gate:old:run:g");
    expect(pendingRow.target).toBe("coo");
    expect(pendingRow.target_kind).toBe("employee");
    expect(pendingRow.requested_by).toBe("legacy");
    expect(pendingRow.requested_at).toBeTruthy();
    expect(pendingRow.decided_by).toBeNull();
    const decidedRow = rows.find((r) => r.work_item_id === decidedId)!;
    expect(decidedRow.state).toBe("approved");
    expect(decidedRow.escalated_at).toBe("2026-07-02T00:00:00.000Z");
    expect(decidedRow.decided_by).toBe("operator");
    expect(decidedRow.decided_at).toBe("2026-07-03T00:00:00.000Z");
    expect(rows.some((r) => r.work_item_id === plainId)).toBe(false);

    // idempotent: a re-run inserts nothing and changes nothing
    const before = JSON.stringify(rows);
    expect(migrate.backfillWorkItemApprovals(db)).toBe(0);
    const after = JSON.stringify(db.prepare("SELECT * FROM work_item_approvals ORDER BY work_item_id").all());
    expect(after).toBe(before);

    // the frozen columns themselves are untouched by the backfill
    const cols = db.prepare("SELECT approval_state FROM work_items WHERE id = ?").get(pendingId) as { approval_state: string };
    expect(cols.approval_state).toBe("pending");
    db.close();
  });

  it("backfills during the v1 → v2 rebuild", () => {
    const file = path.join(tmp, "registry-v1-backfill.db");
    buildV1Fixture(file);
    {
      const raw = new Database(file);
      raw.prepare(
        `UPDATE work_items SET approval_state = 'pending', approval_request = 'v1 pending', approval_target = 'coo', approval_target_kind = 'employee'
         WHERE id = 'ACM-1'`,
      ).run();
      raw.close();
    }
    const db = new Database(file);
    migrate.registerWorkItemIdentityFunctions(db);
    expect(migrate.migrateWorkItemsSchema(db, "v1").rebuilt).toBe(true);
    const row = db.prepare("SELECT * FROM work_item_approvals WHERE work_item_id = 'ACM-1'").get() as Record<string, unknown>;
    expect(row.state).toBe("pending");
    expect(row.request).toBe("v1 pending");
    expect(row.requested_by).toBe("legacy");
    db.close();
  });
});

describe("work_item_approvals self-heal + verifier", () => {
  it("boots a v2 DB missing the approvals table additively and backfills column carriers", () => {
    const file = path.join(tmp, "registry-heal-approvals.db");
    const db = freshV2(file);
    const carrierId = seedItemWithColumns(db, { state: "pending", request: "heal me", target: "coo", target_kind: "employee" });
    db.exec("DROP TABLE work_item_approvals");
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const reopened = new Database(file);
    migrate.registerWorkItemIdentityFunctions(reopened);
    expect(migrate.migrateWorkItemsSchema(reopened).rebuilt).toBe(false);
    migrate.verifyCurrentWorkItemSchema(reopened);
    const row = reopened.prepare("SELECT state, request FROM work_item_approvals WHERE work_item_id = ?").get(carrierId) as Record<string, unknown>;
    expect(row).toEqual({ state: "pending", request: "heal me" });
    reopened.close();
  });

  it("verifier refuses a dangling approval row (unknown work item)", () => {
    const file = path.join(tmp, "registry-verify-dangling.db");
    const db = freshV2(file);
    seedItemWithColumns(db, null);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO work_item_approvals (id, work_item_id, state, request, requested_by, requested_at)
       VALUES ('wap_aaaaaaaaaaaa', 'ZZZ-9', 'approved', 'forged', 'forger', '2026-07-01T00:00:00.000Z')`,
    ).run();
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(/Unsupported prerelease/);
    db.close();
  });

  it("verifier refuses two pending rows for one item even if the unique index is gone (belt and suspenders)", () => {
    const file = path.join(tmp, "registry-verify-dup-pending.db");
    const db = freshV2(file);
    const id = seedItemWithColumns(db, null);
    db.exec("DROP INDEX uq_wap_pending");
    for (const rowId of ["wap_bbbbbbbbbbbb", "wap_cccccccccccc"]) {
      db.prepare(
        `INSERT INTO work_item_approvals (id, work_item_id, state, request, requested_by, requested_at)
         VALUES (?, ?, 'pending', 'dup', 'forger', '2026-07-01T00:00:00.000Z')`,
      ).run(rowId, id);
    }
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(/Unsupported prerelease/);
    db.close();
  });
});
