import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-comments-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Comments = typeof import("../comments.js");
type Migrate = typeof import("../migrate.js");
let store: Store;
let comments: Comments;
let migrate: Migrate;

beforeAll(async () => {
  store = await import("../store.js");
  comments = await import("../comments.js");
  migrate = await import("../migrate.js");
  (await import("../../shared/db.js")).initDb();
});

describe("addComment", () => {
  it("creates a top-level comment, audits comment_added, and bumps the Todo version", () => {
    const item = store.createWorkItem({ title: "commented item" });
    const comment = comments.addComment({
      workItemId: item.id,
      body: "first!",
      author: "operator",
      authorKind: "operator",
    });
    expect(comment.id).toMatch(/^wic_[0-9a-f]{12}$/);
    expect(comment.workItemId).toBe(item.id);
    expect(comment.parentCommentId).toBeNull();
    expect(comment.authorKind).toBe("operator");
    expect(comment.author).toBe("operator");
    expect(comment.body).toBe("first!");
    expect(comment.editedAt).toBeNull();
    expect(comment.deletedAt).toBeNull();

    const events = store.listWorkItemEvents(item.id);
    expect(events.some((e) => e.kind === "comment_added" && e.detail?.commentId === comment.id)).toBe(true);
    expect(store.getWorkItem(item.id)!.version).toBe(item.version + 1);
  });

  it("threads one level deep and re-parents a reply-to-a-reply to the thread root", () => {
    const item = store.createWorkItem({ title: "threaded item" });
    const root = comments.addComment({ workItemId: item.id, body: "root", author: "a-lead", authorKind: "employee" });
    const reply = comments.addComment({
      workItemId: item.id,
      body: "reply",
      author: "operator",
      authorKind: "operator",
      parentCommentId: root.id,
    });
    expect(reply.parentCommentId).toBe(root.id);

    const replyToReply = comments.addComment({
      workItemId: item.id,
      body: "reply to the reply",
      author: "a-lead",
      authorKind: "employee",
      parentCommentId: reply.id,
    });
    expect(replyToReply.parentCommentId).toBe(root.id); // Slack model: depth never > 1
  });

  it("rejects an unknown Todo, an unknown parent, a cross-item parent, and an empty body", () => {
    const item = store.createWorkItem({ title: "guard item" });
    const other = store.createWorkItem({ title: "other item" });
    const onOther = comments.addComment({ workItemId: other.id, body: "elsewhere", author: "operator", authorKind: "operator" });

    expect(() =>
      comments.addComment({ workItemId: "ZZZ-999", body: "orphan", author: "operator", authorKind: "operator" }),
    ).toThrow(/not found/);
    expect(() =>
      comments.addComment({ workItemId: item.id, body: "bad parent", author: "operator", authorKind: "operator", parentCommentId: "wic_000000000000" }),
    ).toThrow(/not found/);
    expect(() =>
      comments.addComment({ workItemId: item.id, body: "cross item", author: "operator", authorKind: "operator", parentCommentId: onOther.id }),
    ).toThrow(/different Todo|not found/);
    expect(() =>
      comments.addComment({ workItemId: item.id, body: "   ", author: "operator", authorKind: "operator" }),
    ).toThrow(/body/);
  });
});

describe("tombstone semantics", () => {
  it("tombstones the body, keeps the row and thread shape, and allows replies to a tombstone", () => {
    const item = store.createWorkItem({ title: "tombstone item" });
    const root = comments.addComment({ workItemId: item.id, body: "delete me", author: "a-lead", authorKind: "employee" });
    const gone = comments.tombstoneComment(root.id, { author: "a-lead", authorKind: "employee", operator: false });
    expect(gone.body).toBe("");
    expect(gone.deletedAt).not.toBeNull();

    // Edit after delete is refused.
    expect(() => comments.editComment(root.id, "resurrect", { author: "a-lead", authorKind: "employee", operator: false })).toThrow(/deleted/);

    // Replying to a tombstone keeps working — the thread shape survives.
    const reply = comments.addComment({
      workItemId: item.id,
      body: "reply under tombstone",
      author: "operator",
      authorKind: "operator",
      parentCommentId: root.id,
    });
    expect(reply.parentCommentId).toBe(root.id);

    // A second delete is an idempotent no-op (no double audit event).
    const again = comments.tombstoneComment(root.id, { author: "a-lead", authorKind: "employee", operator: false });
    expect(again.deletedAt).toBe(gone.deletedAt);
    const deleteEvents = store.listWorkItemEvents(item.id).filter((e) => e.kind === "comment_deleted" && e.detail?.commentId === root.id);
    expect(deleteEvents).toHaveLength(1);
  });
});

describe("authority", () => {
  it("lets the author edit, refuses a non-author, and lets the operator edit/delete any comment", () => {
    const item = store.createWorkItem({ title: "authority item" });
    const theirs = comments.addComment({ workItemId: item.id, body: "mine", author: "a-lead", authorKind: "employee" });

    expect(() => comments.editComment(theirs.id, "hijack", { author: "b-lead", authorKind: "employee", operator: false })).toThrow(/author|forbidden/);
    expect(() => comments.tombstoneComment(theirs.id, { author: "b-lead", authorKind: "employee", operator: false })).toThrow(/author|forbidden/);

    const edited = comments.editComment(theirs.id, "mine, refined", { author: "a-lead", authorKind: "employee", operator: false });
    expect(edited.body).toBe("mine, refined");
    expect(edited.editedAt).not.toBeNull();

    const operatorEdit = comments.editComment(theirs.id, "operator override", { author: "operator", authorKind: "operator", operator: true });
    expect(operatorEdit.body).toBe("operator override");
    const operatorDelete = comments.tombstoneComment(theirs.id, { author: "operator", authorKind: "operator", operator: true });
    expect(operatorDelete.deletedAt).not.toBeNull();
  });

  it("refuses editing an unknown comment", () => {
    expect(() => comments.editComment("wic_ffffffffffff", "nope", { author: "operator", authorKind: "operator", operator: true })).toThrow(/not found/);
  });

  it("discriminates on authorKind: an employee identity colliding with a sentinel author string is refused", () => {
    const item = store.createWorkItem({ title: "sentinel collision item" });
    const operatorComment = comments.addComment({ workItemId: item.id, body: "operator speaking", author: "operator", authorKind: "operator" });
    // An employee slug literally named "operator" produces the same author STRING
    // but a different kind — it must never match the operator's comments.
    const impostor = { author: "operator", authorKind: "employee" as const, operator: false };
    expect(() => comments.editComment(operatorComment.id, "impostor edit", impostor)).toThrow(/author|forbidden/);
    expect(() => comments.tombstoneComment(operatorComment.id, impostor)).toThrow(/author|forbidden/);
    expect(comments.getComment(operatorComment.id)!.body).toBe("operator speaking");

    // Symmetric: the operator surface (operator: true) still overrides any comment.
    const theirs = comments.addComment({ workItemId: item.id, body: "employee words", author: "operator-impostor", authorKind: "employee" });
    expect(comments.tombstoneComment(theirs.id, { author: "operator", authorKind: "operator", operator: true }).deletedAt).not.toBeNull();
  });
});

describe("audit + version effects", () => {
  it("bumps the Todo version on add but not on edit or delete", () => {
    const item = store.createWorkItem({ title: "version item" });
    const afterCreate = store.getWorkItem(item.id)!.version;
    const comment = comments.addComment({ workItemId: item.id, body: "v", author: "operator", authorKind: "operator" });
    const afterAdd = store.getWorkItem(item.id)!.version;
    expect(afterAdd).toBe(afterCreate + 1);

    comments.editComment(comment.id, "v2", { author: "operator", authorKind: "operator", operator: true });
    comments.tombstoneComment(comment.id, { author: "operator", authorKind: "operator", operator: true });
    expect(store.getWorkItem(item.id)!.version).toBe(afterAdd);

    const kinds = store.listWorkItemEvents(item.id).map((e) => e.kind);
    expect(kinds).toContain("comment_added");
    expect(kinds).toContain("comment_edited");
    expect(kinds).toContain("comment_deleted");
  });
});

describe("pagination", () => {
  it("lists chronologically with limit/offset and exposes the tail", () => {
    const item = store.createWorkItem({ title: "paged item" });
    const created: string[] = [];
    for (let i = 1; i <= 12; i++) {
      created.push(comments.addComment({ workItemId: item.id, body: `c${i}`, author: "operator", authorKind: "operator" }).id);
    }

    const all = comments.listComments(item.id);
    expect(all.total).toBe(12);
    expect(all.comments.map((c) => c.body)).toEqual(Array.from({ length: 12 }, (_, i) => `c${i + 1}`));

    const page = comments.listComments(item.id, { limit: 5, offset: 5 });
    expect(page.total).toBe(12);
    expect(page.comments.map((c) => c.body)).toEqual(["c6", "c7", "c8", "c9", "c10"]);

    const tail = comments.commentsTail(item.id);
    expect(tail.total).toBe(12);
    expect(tail.comments.map((c) => c.body)).toEqual(Array.from({ length: 10 }, (_, i) => `c${i + 3}`)); // last 10, chronological

    const shortTail = comments.commentsTail(item.id, 3);
    expect(shortTail.comments.map((c) => c.body)).toEqual(["c10", "c11", "c12"]);

    // Limit is capped at 500 per page.
    expect(comments.listComments(item.id, { limit: 100_000 }).comments.length).toBe(12);
  });
});

describe("migration self-heal + verifier", () => {
  function freshV2(file: string): Database.Database {
    const db = new Database(file);
    migrate.registerWorkItemIdentityFunctions(db);
    migrate.migrateWorkItemsSchema(db, "absent");
    return db;
  }

  it("recreates a missing comments table additively — no rebuild, no refusal", () => {
    const file = path.join(tmp, "registry-selfheal.db");
    const db = freshV2(file);
    const claim = migrate.allocateWorkItemId(db, "2026-07-01T00:00:00.000Z", "ACM");
    migrate.useWorkItemAllocationClaim(db, claim, () => {
      db.prepare(
        `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
         VALUES (?, 'survivor', 'backlog', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
      ).run(claim.id, claim.id, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    });
    db.exec("DROP TABLE work_item_comments");
    db.close();

    // Read-only preflight of a comments-less v2 DB must not refuse.
    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const reopened = new Database(file);
    migrate.registerWorkItemIdentityFunctions(reopened);
    const result = migrate.migrateWorkItemsSchema(reopened);
    expect(result.rebuilt).toBe(false);
    migrate.verifyCurrentWorkItemSchema(reopened); // table restored, shape green
    expect(reopened.prepare("SELECT COUNT(*) FROM work_items").pluck().get()).toBe(1); // data untouched
    reopened.close();
  });

  it("refuses dangling comment references", () => {
    const base = "2026-07-01T00:00:00.000Z";
    const withItem = (file: string, fn: (db: Database.Database, itemId: string) => void): void => {
      const db = freshV2(file);
      const claim = migrate.allocateWorkItemId(db, base, "ACM");
      migrate.useWorkItemAllocationClaim(db, claim, () => {
        db.prepare(
          `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
           VALUES (?, 'host', 'backlog', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
        ).run(claim.id, claim.id, base, base);
      });
      fn(db, claim.id);
      db.close();
    };

    const insertComment = (db: Database.Database, id: string, itemId: string, parent: string | null): void => {
      // Forge corruption a well-behaved connection cannot produce (better-sqlite3
      // enforces foreign keys) — the verifier must still catch external writers.
      db.pragma("foreign_keys = OFF");
      db.prepare(
        `INSERT INTO work_item_comments (id, work_item_id, parent_comment_id, author_kind, author, body, created_at)
         VALUES (?, ?, ?, 'operator', 'operator', 'x', ?)`,
      ).run(id, itemId, parent, base);
    };

    // Comment pointing at a Todo that does not exist.
    withItem(path.join(tmp, "registry-dangle-item.db"), (db) => {
      insertComment(db, "wic_aaaaaaaaaaaa", "ACM-9", null);
      expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(/Unsupported prerelease/);
    });

    // Parent on a DIFFERENT work item.
    withItem(path.join(tmp, "registry-dangle-cross.db"), (db, itemId) => {
      const claim2 = migrate.allocateWorkItemId(db, base, "ACM");
      migrate.useWorkItemAllocationClaim(db, claim2, () => {
        db.prepare(
          `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
           VALUES (?, 'second', 'backlog', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
        ).run(claim2.id, claim2.id, base, base);
      });
      insertComment(db, "wic_bbbbbbbbbbbb", itemId, null);
      insertComment(db, "wic_cccccccccccc", claim2.id, "wic_bbbbbbbbbbbb");
      expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(/Unsupported prerelease/);
    });

    // Parent that is itself a reply (depth > 1 forged directly in SQL).
    withItem(path.join(tmp, "registry-dangle-depth.db"), (db, itemId) => {
      insertComment(db, "wic_dddddddddddd", itemId, null);
      insertComment(db, "wic_eeeeeeeeeeee", itemId, "wic_dddddddddddd");
      insertComment(db, "wic_ffffffffffff", itemId, "wic_eeeeeeeeeeee");
      expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(/Unsupported prerelease/);
    });

    // Parent id that resolves to no comment row at all.
    withItem(path.join(tmp, "registry-dangle-parent.db"), (db, itemId) => {
      insertComment(db, "wic_111111111111", itemId, "wic_000000000000");
      expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(/Unsupported prerelease/);
    });
  });
});
