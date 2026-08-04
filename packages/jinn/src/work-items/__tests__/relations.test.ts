import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-relations-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Relations = typeof import("../relations.js");
type Migrate = typeof import("../migrate.js");
let store: Store;
let relations: Relations;
let migrate: Migrate;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  relations = await import("../relations.js");
  migrate = await import("../migrate.js");
  db = (await import("../../shared/db.js")).initDb();
});

function setStatus(id: string, status: string): void {
  db.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(status, id);
}

describe("addRelation", () => {
  it("adds a directional blocks relation, audits both endpoints, and bumps both versions", () => {
    const a = store.createWorkItem({ title: "blocker" });
    const b = store.createWorkItem({ title: "blocked" });
    const relation = relations.addRelation(a.id, b.id, "blocks", "operator");
    expect(relation).toMatchObject({ srcId: a.id, dstId: b.id, kind: "blocks", createdBy: "operator" });

    for (const item of [a, b]) {
      const events = store.listWorkItemEvents(item.id);
      expect(events.some((e) => e.kind === "relation_added" && e.detail?.kind === "blocks")).toBe(true);
      expect(store.getWorkItem(item.id)!.version).toBe(item.version + 1);
    }
  });

  it("stores relates ONCE in canonical order regardless of call order, idempotently", () => {
    const a = store.createWorkItem({ title: "rel a" });
    const b = store.createWorkItem({ title: "rel b" });
    const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];

    const first = relations.addRelation(hi, lo, "relates", "operator");
    expect(first.srcId).toBe(lo);
    expect(first.dstId).toBe(hi);

    const versionAfterFirst = store.getWorkItem(a.id)!.version;
    // Re-adding in either order returns the existing row and appends no events.
    const again = relations.addRelation(lo, hi, "relates", "operator");
    expect(again.createdAt).toBe(first.createdAt);
    const reversed = relations.addRelation(hi, lo, "relates", "operator");
    expect(reversed.createdAt).toBe(first.createdAt);
    expect(store.getWorkItem(a.id)!.version).toBe(versionAfterFirst);

    const rows = db.prepare("SELECT COUNT(*) FROM work_item_relations WHERE kind = 'relates'").pluck().get();
    expect(rows).toBe(1);
  });

  it("refuses a direct blocks cycle with the cycle path in the message", () => {
    const a = store.createWorkItem({ title: "cycle a" });
    const b = store.createWorkItem({ title: "cycle b" });
    relations.addRelation(a.id, b.id, "blocks", "operator");
    expect(() => relations.addRelation(b.id, a.id, "blocks", "operator")).toThrow(
      `${b.id} blocks ${a.id} would create a cycle: ${b.id} → ${a.id} → ${b.id}`,
    );
    try {
      relations.addRelation(b.id, a.id, "blocks", "operator");
      expect.unreachable("cycle must throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("relation-cycle");
    }
  });

  it("refuses a transitive blocks cycle", () => {
    const a = store.createWorkItem({ title: "chain a" });
    const b = store.createWorkItem({ title: "chain b" });
    const c = store.createWorkItem({ title: "chain c" });
    relations.addRelation(a.id, b.id, "blocks", "operator");
    relations.addRelation(b.id, c.id, "blocks", "operator");
    expect(() => relations.addRelation(c.id, a.id, "blocks", "operator")).toThrow(/cycle/);
    // relates/duplicates between the same endpoints stay legal (no meaningful cycle).
    expect(relations.addRelation(c.id, a.id, "relates", "operator").kind).toBe("relates");
    expect(relations.addRelation(c.id, a.id, "duplicates", "operator").kind).toBe("duplicates");
  });

  it("refuses self-relations and unknown endpoints", () => {
    const a = store.createWorkItem({ title: "self" });
    expect(() => relations.addRelation(a.id, a.id, "relates", "operator")).toThrow(/itself/);
    expect(() => relations.addRelation(a.id, "ZZZ-999", "blocks", "operator")).toThrow(/not found/);
    expect(() => relations.addRelation("ZZZ-999", a.id, "blocks", "operator")).toThrow(/not found/);
  });

  it("allows cross-department relations", () => {
    const a = store.createWorkItem({ title: "platform item", department: "platform" });
    const b = store.createWorkItem({ title: "marketing item", department: "marketing" });
    const relation = relations.addRelation(a.id, b.id, "blocks", "operator");
    expect(relation.srcId).toBe(a.id);
    expect(a.id.slice(0, 3)).not.toBe(b.id.slice(0, 3)); // genuinely cross-prefix
  });
});

describe("removeRelation", () => {
  it("lets the creator remove, refuses a stranger, and lets the operator remove any", () => {
    const a = store.createWorkItem({ title: "rm a" });
    const b = store.createWorkItem({ title: "rm b" });
    relations.addRelation(a.id, b.id, "blocks", "session:one");

    expect(() =>
      relations.removeRelation(a.id, b.id, "blocks", { actor: "session:two", operator: false }),
    ).toThrow(/creator|operator/);
    expect(relations.removeRelation(a.id, b.id, "blocks", { actor: "session:one", operator: false })).toBe(true);

    relations.addRelation(a.id, b.id, "blocks", "session:one");
    expect(relations.removeRelation(a.id, b.id, "blocks", { actor: "operator", operator: true })).toBe(true);

    const events = store.listWorkItemEvents(a.id).filter((e) => e.kind === "relation_removed");
    expect(events).toHaveLength(2);
    expect(store.listWorkItemEvents(b.id).filter((e) => e.kind === "relation_removed")).toHaveLength(2);
  });

  it("returns false for an absent relation and accepts relates in either order", () => {
    const a = store.createWorkItem({ title: "sym a" });
    const b = store.createWorkItem({ title: "sym b" });
    expect(relations.removeRelation(a.id, b.id, "blocks", { actor: "operator", operator: true })).toBe(false);

    const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    relations.addRelation(lo, hi, "relates", "operator");
    // Removal given in NON-canonical order still finds the canonical row.
    expect(relations.removeRelation(hi, lo, "relates", { actor: "operator", operator: true })).toBe(true);
    expect(db.prepare("SELECT COUNT(*) FROM work_item_relations WHERE kind = 'relates' AND src_id = ?").pluck().get(lo)).toBe(0);
  });
});

describe("listRelations", () => {
  it("resolves both directions with the other endpoint, relates always direction out", () => {
    const a = store.createWorkItem({ title: "hub" });
    const b = store.createWorkItem({ title: "spoke b" });
    const c = store.createWorkItem({ title: "spoke c" });
    relations.addRelation(a.id, b.id, "blocks", "operator");
    relations.addRelation(c.id, a.id, "blocks", "operator");
    const [lo, hi] = a.id < c.id ? [a.id, c.id] : [c.id, a.id];
    relations.addRelation(lo, hi, "relates", "operator");

    const views = relations.listRelations(a.id);
    expect(views).toHaveLength(3);
    const outBlocks = views.find((v) => v.kind === "blocks" && v.direction === "out");
    expect(outBlocks?.other).toMatchObject({ id: b.id, title: "spoke b", status: "backlog" });
    const inBlocks = views.find((v) => v.kind === "blocks" && v.direction === "in");
    expect(inBlocks?.other.id).toBe(c.id);
    const relatesView = views.find((v) => v.kind === "relates");
    expect(relatesView?.direction).toBe("out"); // symmetric: never rendered as incoming
    expect(relatesView?.other.id).toBe(c.id);
  });
});

describe("isBlocked + blockedSet", () => {
  it("is blocked only while an incoming blocks edge originates from a non-terminal item", () => {
    const blocker = store.createWorkItem({ title: "gate" });
    const blocked = store.createWorkItem({ title: "waiting" });
    relations.addRelation(blocker.id, blocked.id, "blocks", "operator");

    expect(relations.isBlocked(blocked.id)).toBe(true);
    expect(relations.isBlocked(blocker.id)).toBe(false);

    setStatus(blocker.id, "done");
    expect(relations.isBlocked(blocked.id)).toBe(false);
    setStatus(blocker.id, "cancelled");
    expect(relations.isBlocked(blocked.id)).toBe(false);
    // Escalated is sticky but NOT closed — it still blocks.
    setStatus(blocker.id, "escalated");
    expect(relations.isBlocked(blocked.id)).toBe(true);
  });

  it("blockedSet answers many items in one query-shaped batch", () => {
    const openBlocker = store.createWorkItem({ title: "live gate" });
    const doneBlocker = store.createWorkItem({ title: "closed gate" });
    const x = store.createWorkItem({ title: "x" });
    const y = store.createWorkItem({ title: "y" });
    const z = store.createWorkItem({ title: "z" });
    relations.addRelation(openBlocker.id, x.id, "blocks", "operator");
    relations.addRelation(doneBlocker.id, y.id, "blocks", "operator");
    setStatus(doneBlocker.id, "done");

    const set = relations.blockedSet([x.id, y.id, z.id]);
    expect(set.has(x.id)).toBe(true);
    expect(set.has(y.id)).toBe(false);
    expect(set.has(z.id)).toBe(false);
    expect(relations.blockedSet([])).toEqual(new Set());
  });
});

describe("additive self-heal generalization", () => {
  function freshV2(file: string): Database.Database {
    const fresh = new Database(file);
    migrate.registerWorkItemIdentityFunctions(fresh);
    migrate.migrateWorkItemsSchema(fresh, "absent");
    return fresh;
  }

  function seedItem(fresh: Database.Database): string {
    const base = "2026-07-01T00:00:00.000Z";
    const claim = migrate.allocateWorkItemId(fresh, base, "ACM");
    migrate.useWorkItemAllocationClaim(fresh, claim, () => {
      fresh.prepare(
        `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
         VALUES (?, 'survivor', 'backlog', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
      ).run(claim.id, claim.id, base, base);
    });
    return claim.id;
  }

  it("boots a v2 DB missing relations + labels tables additively — no rebuild, no refusal", () => {
    const file = path.join(tmp, "registry-heal-slice3.db");
    const fresh = freshV2(file);
    seedItem(fresh);
    fresh.exec("DROP TABLE work_item_labels");
    fresh.exec("DROP TABLE labels");
    fresh.exec("DROP TABLE work_item_relations");
    fresh.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const reopened = new Database(file);
    migrate.registerWorkItemIdentityFunctions(reopened);
    const result = migrate.migrateWorkItemsSchema(reopened);
    expect(result.rebuilt).toBe(false);
    migrate.verifyCurrentWorkItemSchema(reopened);
    expect(reopened.prepare("SELECT COUNT(*) FROM work_items").pluck().get()).toBe(1);
    reopened.close();
  });

  it("heals a slice-1 shape missing every additive table (comments included)", () => {
    const file = path.join(tmp, "registry-heal-slice1.db");
    const fresh = freshV2(file);
    seedItem(fresh);
    for (const name of ["work_item_labels", "labels", "work_item_relations", "work_item_comments"]) {
      fresh.exec(`DROP TABLE ${name}`);
    }
    fresh.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");
    const reopened = new Database(file);
    migrate.registerWorkItemIdentityFunctions(reopened);
    expect(migrate.migrateWorkItemsSchema(reopened).rebuilt).toBe(false);
    migrate.verifyCurrentWorkItemSchema(reopened);
    reopened.close();
  });

  it("still refuses a wrong-shape additive table at preflight", () => {
    const file = path.join(tmp, "registry-heal-wrongshape.db");
    const fresh = freshV2(file);
    fresh.exec("DROP TABLE work_item_relations");
    fresh.exec("CREATE TABLE work_item_relations (whatever TEXT)");
    fresh.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(/Unsupported prerelease/);
  });
});

describe("verifier refusals", () => {
  const base = "2026-07-01T00:00:00.000Z";

  function withItems(file: string, fn: (fresh: Database.Database, ids: string[]) => void): void {
    const fresh = new Database(file);
    migrate.registerWorkItemIdentityFunctions(fresh);
    migrate.migrateWorkItemsSchema(fresh, "absent");
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const claim = migrate.allocateWorkItemId(fresh, base, "ACM");
      migrate.useWorkItemAllocationClaim(fresh, claim, () => {
        fresh.prepare(
          `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
           VALUES (?, 'host', 'backlog', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
        ).run(claim.id, claim.id, base, base);
      });
      ids.push(claim.id);
    }
    fn(fresh, ids);
    fresh.close();
  }

  function forgeRelation(fresh: Database.Database, src: string, dst: string, kind: string): void {
    // Forge corruption a well-behaved connection cannot produce (better-sqlite3
    // enforces foreign keys) — the verifier must still catch external writers.
    fresh.pragma("foreign_keys = OFF");
    fresh.prepare(
      "INSERT INTO work_item_relations (src_id, dst_id, kind, created_by, created_at) VALUES (?, ?, ?, 'operator', ?)",
    ).run(src, dst, kind, base);
  }

  it("refuses a dangling relation endpoint", () => {
    withItems(path.join(tmp, "registry-rel-dangle.db"), (fresh, [a]) => {
      forgeRelation(fresh, a, "ACM-9", "blocks");
      expect(() => migrate.verifyCurrentWorkItemSchema(fresh)).toThrow(/Unsupported prerelease/);
    });
  });

  it("refuses a non-canonical relates row", () => {
    withItems(path.join(tmp, "registry-rel-canon.db"), (fresh, [a, b]) => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      forgeRelation(fresh, hi, lo, "relates"); // stored backwards
      expect(() => migrate.verifyCurrentWorkItemSchema(fresh)).toThrow(/Unsupported prerelease/);
    });
  });

  it("refuses a blocks cycle present in the data", () => {
    withItems(path.join(tmp, "registry-rel-cycle.db"), (fresh, [a, b]) => {
      forgeRelation(fresh, a, b, "blocks");
      forgeRelation(fresh, b, a, "blocks");
      expect(() => migrate.verifyCurrentWorkItemSchema(fresh)).toThrow(/Unsupported prerelease/);
    });
  });

  it("refuses a work_item_labels pair referencing a missing item or label", () => {
    withItems(path.join(tmp, "registry-lbl-dangle.db"), (fresh, [a]) => {
      fresh.pragma("foreign_keys = OFF");
      fresh.prepare("INSERT INTO labels (id, name, created_at) VALUES ('lbl_aaaaaaaaaaaa', 'bug', ?)").run(base);
      fresh.prepare("INSERT INTO work_item_labels (work_item_id, label_id) VALUES (?, 'lbl_000000000000')").run(a);
      expect(() => migrate.verifyCurrentWorkItemSchema(fresh)).toThrow(/Unsupported prerelease/);
    });
    withItems(path.join(tmp, "registry-lbl-dangle2.db"), (fresh) => {
      fresh.pragma("foreign_keys = OFF");
      fresh.prepare("INSERT INTO labels (id, name, created_at) VALUES ('lbl_bbbbbbbbbbbb', 'ops', ?)").run(base);
      fresh.prepare("INSERT INTO work_item_labels (work_item_id, label_id) VALUES ('ACM-9', 'lbl_bbbbbbbbbbbb')").run();
      expect(() => migrate.verifyCurrentWorkItemSchema(fresh)).toThrow(/Unsupported prerelease/);
    });
  });
});
