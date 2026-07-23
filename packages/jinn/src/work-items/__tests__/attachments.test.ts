import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-attach-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Comments = typeof import("../comments.js");
type Attachments = typeof import("../attachments.js");
type Migrate = typeof import("../migrate.js");
let store: Store;
let comments: Comments;
let attachments: Attachments;
let migrate: Migrate;
let db: import("better-sqlite3").Database;

const OPERATOR = { author: "operator", authorKind: "operator", operator: true } as const;
const LEAD = { author: "a-lead", authorKind: "employee", operator: false } as const;
const DEV = { author: "b-dev", authorKind: "employee", operator: false } as const;

beforeAll(async () => {
  store = await import("../store.js");
  comments = await import("../comments.js");
  attachments = await import("../attachments.js");
  migrate = await import("../migrate.js");
  db = (await import("../../sessions/registry.js")).initDb();
});

function stage(content: Buffer | string): string {
  return attachments.stageAttachmentBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content));
}

function sha(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("addAttachment", () => {
  it("stores an item-level attachment content-addressed with a state-bumping audit event", () => {
    const item = store.createWorkItem({ title: "attach host" });
    const content = Buffer.from("hello attachment");
    const row = attachments.addAttachment({
      workItemId: item.id,
      filename: "notes.txt",
      mime: "text/plain",
      stagedPath: stage(content),
      uploader: OPERATOR,
    });
    expect(row.id).toMatch(/^wia_[0-9a-f]{12}$/);
    expect(row.workItemId).toBe(item.id);
    expect(row.commentId).toBeNull();
    expect(row.filename).toBe("notes.txt");
    expect(row.mime).toBe("text/plain");
    expect(row.bytes).toBe(content.length);
    expect(row.sha256).toBe(sha(content));
    expect(row.uploadedBy).toBe("operator");
    // Content-addressed layout: <attachments>/<sha[0:2]>/<sha>, absolute on the read surface.
    expect(path.isAbsolute(row.storagePath)).toBe(true);
    expect(row.storagePath).toBe(attachments.attachmentPath(row.sha256));
    expect(row.storagePath.endsWith(path.join(row.sha256.slice(0, 2), row.sha256))).toBe(true);
    expect(fs.readFileSync(row.storagePath)).toEqual(content);
    // The DB row keeps the RELATIVE form (spec §3.2: relative to <instance>/attachments/).
    const raw = db.prepare("SELECT storage_path FROM work_item_attachments WHERE id = ?").get(row.id) as { storage_path: string };
    expect(raw.storage_path).toBe(`${row.sha256.slice(0, 2)}/${row.sha256}`);

    const events = store.listWorkItemEvents(item.id);
    expect(events.some((e) => e.kind === "attachment_added" && e.detail?.attachmentId === row.id)).toBe(true);
    expect(store.getWorkItem(item.id)!.version).toBe(item.version + 1);
  });

  it("falls back to application/octet-stream when no mime is given", () => {
    const item = store.createWorkItem({ title: "mime fallback" });
    const row = attachments.addAttachment({
      workItemId: item.id,
      filename: "mystery.bin",
      stagedPath: stage("??"),
      uploader: OPERATOR,
    });
    expect(row.mime).toBe("application/octet-stream");
  });

  it("consumes the staged file (moved into place, not left behind)", () => {
    const item = store.createWorkItem({ title: "staging" });
    const staged = stage("staged once");
    attachments.addAttachment({ workItemId: item.id, filename: "a.txt", stagedPath: staged, uploader: OPERATOR });
    expect(fs.existsSync(staged)).toBe(false);
  });

  it("refuses an unknown Todo and an unknown staged path", () => {
    expect(() =>
      attachments.addAttachment({ workItemId: "ZZZ-999", filename: "x", stagedPath: stage("x"), uploader: OPERATOR }),
    ).toThrow(/not found/);
    const item = store.createWorkItem({ title: "no staged" });
    expect(() =>
      attachments.addAttachment({ workItemId: item.id, filename: "x", stagedPath: path.join(tmp, "nope"), uploader: OPERATOR }),
    ).toThrow(/staged/i);
  });
});

describe("comment attachments", () => {
  it("attaches to the uploader's own comment; the row carries the comment id", () => {
    const item = store.createWorkItem({ title: "comment host" });
    const comment = comments.addComment({ workItemId: item.id, body: "here is a screenshot", author: "a-lead", authorKind: "employee" });
    const row = attachments.addAttachment({
      workItemId: item.id,
      commentId: comment.id,
      filename: "shot.png",
      mime: "image/png",
      stagedPath: stage("png bytes"),
      uploader: LEAD,
    });
    expect(row.commentId).toBe(comment.id);
    const listed = attachments.listAttachments(item.id);
    expect(listed.filter((a) => a.commentId === comment.id).map((a) => a.id)).toEqual([row.id]);
  });

  it("refuses attaching to someone else's comment; the comment author and the operator may", () => {
    const item = store.createWorkItem({ title: "foreign comment" });
    const comment = comments.addComment({ workItemId: item.id, body: "mine", author: "a-lead", authorKind: "employee" });
    expect(() =>
      attachments.addAttachment({ workItemId: item.id, commentId: comment.id, filename: "x", stagedPath: stage("x1"), uploader: DEV }),
    ).toThrow(/comment author/);
    // Operator override stands.
    const byOperator = attachments.addAttachment({
      workItemId: item.id, commentId: comment.id, filename: "op.txt", stagedPath: stage("op"), uploader: OPERATOR,
    });
    expect(byOperator.commentId).toBe(comment.id);
  });

  it("pairs (author, authorKind) — an employee slug colliding with a sentinel cannot claim operator comments", () => {
    const item = store.createWorkItem({ title: "sentinel" });
    const comment = comments.addComment({ workItemId: item.id, body: "operator note", author: "operator", authorKind: "operator" });
    expect(() =>
      attachments.addAttachment({
        workItemId: item.id, commentId: comment.id, filename: "x",
        stagedPath: stage("imp"), uploader: { author: "operator", authorKind: "employee", operator: false },
      }),
    ).toThrow(/comment author/);
  });

  it("refuses a comment from a different Todo and an unknown comment", () => {
    const a = store.createWorkItem({ title: "item a" });
    const b = store.createWorkItem({ title: "item b" });
    const onB = comments.addComment({ workItemId: b.id, body: "b's comment", author: "operator", authorKind: "operator" });
    expect(() =>
      attachments.addAttachment({ workItemId: a.id, commentId: onB.id, filename: "x", stagedPath: stage("x2"), uploader: OPERATOR }),
    ).toThrow(/different Todo/);
    expect(() =>
      attachments.addAttachment({ workItemId: a.id, commentId: "wic_000000000000", filename: "x", stagedPath: stage("x3"), uploader: OPERATOR }),
    ).toThrow(/not found/);
  });

  it("refuses attaching to a tombstoned comment (comment must be live at attach time)", () => {
    const item = store.createWorkItem({ title: "tombstone" });
    const comment = comments.addComment({ workItemId: item.id, body: "soon gone", author: "operator", authorKind: "operator" });
    comments.tombstoneComment(comment.id, { author: "operator", authorKind: "operator", operator: true });
    expect(() =>
      attachments.addAttachment({ workItemId: item.id, commentId: comment.id, filename: "x", stagedPath: stage("x4"), uploader: OPERATOR }),
    ).toThrow(/deleted/);
  });

  it("tombstoning a comment does NOT delete its attachment rows (history semantics)", () => {
    const item = store.createWorkItem({ title: "tombstone keeps rows" });
    const comment = comments.addComment({ workItemId: item.id, body: "with file", author: "operator", authorKind: "operator" });
    const row = attachments.addAttachment({
      workItemId: item.id, commentId: comment.id, filename: "keep.txt", stagedPath: stage("keep"), uploader: OPERATOR,
    });
    comments.tombstoneComment(comment.id, { author: "operator", authorKind: "operator", operator: true });
    expect(attachments.getAttachment(row.id)).toBeDefined();
    expect(fs.existsSync(row.storagePath)).toBe(true);
  });
});

describe("dedup + removal refcounting", () => {
  it("identical content on two items dedupes to ONE file; removing one row keeps it, removing the last unlinks it", () => {
    const a = store.createWorkItem({ title: "dedup a" });
    const b = store.createWorkItem({ title: "dedup b" });
    const content = Buffer.from("shared bytes");
    const first = attachments.addAttachment({ workItemId: a.id, filename: "one.txt", stagedPath: stage(content), uploader: OPERATOR });
    const second = attachments.addAttachment({ workItemId: b.id, filename: "two.txt", stagedPath: stage(content), uploader: OPERATOR });
    expect(first.sha256).toBe(second.sha256);
    expect(first.storagePath).toBe(second.storagePath);
    expect(first.id).not.toBe(second.id);

    expect(attachments.removeAttachment(first.id, OPERATOR)).toBe(true);
    expect(attachments.getAttachment(first.id)).toBeUndefined();
    expect(fs.existsSync(second.storagePath)).toBe(true); // still referenced by the second row

    expect(attachments.removeAttachment(second.id, OPERATOR)).toBe(true);
    expect(fs.existsSync(second.storagePath)).toBe(false); // last reference gone

    const events = store.listWorkItemEvents(a.id);
    expect(events.some((e) => e.kind === "attachment_removed" && e.detail?.attachmentId === first.id)).toBe(true);
    // Removal is audit-only — it does not churn the Todo version.
    const versionEvents = store.listWorkItemEvents(a.id).filter((e) => e.kind === "attachment_removed");
    expect(versionEvents).toHaveLength(1);
  });

  it("a same-content re-upload repairs a corrupted content-addressed blob (review F4)", () => {
    const a = store.createWorkItem({ title: "repair a" });
    const content = Buffer.from("repairable bytes");
    const first = attachments.addAttachment({ workItemId: a.id, filename: "r1.txt", stagedPath: stage(content), uploader: OPERATOR });
    fs.writeFileSync(first.storagePath, "corrupted-on-disk");

    const b = store.createWorkItem({ title: "repair b" });
    const second = attachments.addAttachment({ workItemId: b.id, filename: "r2.txt", stagedPath: stage(content), uploader: OPERATOR });
    expect(second.sha256).toBe(first.sha256);
    // The dedup path verified the existing blob, found it wrong, and atomically
    // replaced it with the known-good staged copy.
    expect(fs.readFileSync(second.storagePath)).toEqual(content);
    expect(fs.readFileSync(first.storagePath)).toEqual(content);
  });

  it("removal is uploader-or-operator", () => {
    const item = store.createWorkItem({ title: "remove authority" });
    const row = attachments.addAttachment({ workItemId: item.id, filename: "mine.txt", stagedPath: stage("lead's"), uploader: LEAD });
    expect(() => attachments.removeAttachment(row.id, DEV)).toThrow(/uploader/);
    expect(attachments.getAttachment(row.id)).toBeDefined();
    expect(attachments.removeAttachment(row.id, OPERATOR)).toBe(true);
  });

  it("removing an unknown attachment returns false", () => {
    expect(attachments.removeAttachment("wia_000000000000", OPERATOR)).toBe(false);
  });
});

describe("caps", () => {
  it("accepts exactly 25 MB, refuses one byte more, and enforces the 200 MB per-item sum (comment rows included)", () => {
    const item = store.createWorkItem({ title: "caps host" });
    const comment = comments.addComment({ workItemId: item.id, body: "cap comment", author: "operator", authorKind: "operator" });
    const big = Buffer.alloc(attachments.ATTACHMENT_MAX_BYTES, 7);

    // 8 × 25 MB = exactly 200 MB. Identical content dedupes on disk but every
    // row's bytes count toward the item budget; two of the rows live on a comment.
    for (let i = 0; i < 8; i++) {
      const row = attachments.addAttachment({
        workItemId: item.id,
        commentId: i < 2 ? comment.id : null,
        filename: `big-${i}.bin`,
        stagedPath: stage(big),
        uploader: OPERATOR,
      });
      expect(row.bytes).toBe(attachments.ATTACHMENT_MAX_BYTES);
    }
    expect(attachments.itemBytesUsed(item.id)).toBe(attachments.ATTACHMENT_ITEM_MAX_BYTES);

    // The sum cap is exact: a single further byte is refused.
    expect(() =>
      attachments.addAttachment({ workItemId: item.id, filename: "straw.txt", stagedPath: stage("!"), uploader: OPERATOR }),
    ).toThrow(/200/);

    // Per-file cap is exact too — and the refusal leaves nothing behind.
    const over = Buffer.alloc(attachments.ATTACHMENT_MAX_BYTES + 1, 7);
    const other = store.createWorkItem({ title: "per-file cap" });
    expect(() =>
      attachments.addAttachment({ workItemId: other.id, filename: "over.bin", stagedPath: stage(over), uploader: OPERATOR }),
    ).toThrow(/25/);
    expect(attachments.listAttachments(other.id)).toHaveLength(0);
    expect(fs.existsSync(attachments.attachmentPath(sha(over)))).toBe(false);
  });
});

describe("listAttachments", () => {
  it("lists item-level and per-comment rows chronologically", () => {
    const item = store.createWorkItem({ title: "list host" });
    const comment = comments.addComment({ workItemId: item.id, body: "c", author: "operator", authorKind: "operator" });
    const one = attachments.addAttachment({ workItemId: item.id, filename: "one.txt", stagedPath: stage("l1"), uploader: OPERATOR });
    const two = attachments.addAttachment({ workItemId: item.id, commentId: comment.id, filename: "two.txt", stagedPath: stage("l2"), uploader: OPERATOR });
    const listed = attachments.listAttachments(item.id);
    expect(listed.map((a) => a.id)).toEqual([one.id, two.id]);
    expect(listed[0].commentId).toBeNull();
    expect(listed[1].commentId).toBe(comment.id);
  });
});

describe("additive self-heal (6th entry)", () => {
  function freshV2(file: string): Database.Database {
    const fresh = new Database(file);
    migrate.registerWorkItemIdentityFunctions(fresh);
    migrate.migrateWorkItemsSchema(fresh, "absent");
    return fresh;
  }

  it("boots a v2 DB missing work_item_attachments additively — no rebuild, no refusal", () => {
    const file = path.join(tmp, "registry-heal-attach.db");
    const fresh = freshV2(file);
    fresh.exec("DROP TABLE work_item_attachments");
    fresh.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");
    const reopened = new Database(file);
    migrate.registerWorkItemIdentityFunctions(reopened);
    expect(migrate.migrateWorkItemsSchema(reopened).rebuilt).toBe(false);
    migrate.verifyCurrentWorkItemSchema(reopened);
    reopened.close();
  });

  it("still refuses a wrong-shape attachments table at preflight", () => {
    const file = path.join(tmp, "registry-heal-attach-wrongshape.db");
    const fresh = freshV2(file);
    fresh.exec("DROP TABLE work_item_attachments");
    fresh.exec("CREATE TABLE work_item_attachments (whatever TEXT)");
    fresh.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(/Unsupported prerelease/);
  });
});

describe("verifier refusals", () => {
  const base = "2026-07-01T00:00:00.000Z";

  function withItem(file: string, fn: (fresh: Database.Database, id: string) => void): void {
    const fresh = new Database(file);
    migrate.registerWorkItemIdentityFunctions(fresh);
    migrate.migrateWorkItemsSchema(fresh, "absent");
    const claim = migrate.allocateWorkItemId(fresh, base, "ACM");
    migrate.useWorkItemAllocationClaim(fresh, claim, () => {
      fresh.prepare(
        `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
         VALUES (?, 'host', 'backlog', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
      ).run(claim.id, claim.id, base, base);
    });
    fn(fresh, claim.id);
    fresh.close();
  }

  function forgeAttachment(fresh: Database.Database, itemId: string, opts: { commentId?: string | null; sha?: string } = {}): void {
    // Forge corruption a well-behaved connection cannot produce (better-sqlite3
    // enforces foreign keys) — the verifier must still catch external writers.
    fresh.pragma("foreign_keys = OFF");
    const digest = opts.sha ?? sha(`forge-${itemId}-${opts.commentId ?? ""}`);
    fresh.prepare(
      `INSERT INTO work_item_attachments (id, work_item_id, comment_id, filename, mime, bytes, sha256, storage_path, uploaded_by, created_at)
       VALUES ('wia_${createHash("sha1").update(digest).digest("hex").slice(0, 12)}', ?, ?, 'f', 'text/plain', 1, ?, ?, 'operator', ?)`,
    ).run(itemId, opts.commentId ?? null, digest, `${digest.slice(0, 2)}/${digest}`, base);
  }

  it("refuses an attachment row referencing a missing item", () => {
    withItem(path.join(tmp, "registry-att-dangle.db"), (fresh) => {
      forgeAttachment(fresh, "ACM-9");
      expect(() => migrate.verifyCurrentWorkItemSchema(fresh)).toThrow(/Unsupported prerelease/);
    });
  });

  it("refuses a comment-scoped row whose comment belongs to a DIFFERENT item (or is missing)", () => {
    withItem(path.join(tmp, "registry-att-xcomment.db"), (fresh, id) => {
      forgeAttachment(fresh, id, { commentId: "wic_ffffffffffff" });
      expect(() => migrate.verifyCurrentWorkItemSchema(fresh)).toThrow(/Unsupported prerelease/);
    });
  });

  it("refuses a malformed sha256", () => {
    withItem(path.join(tmp, "registry-att-sha.db"), (fresh, id) => {
      forgeAttachment(fresh, id, { sha: "Z".repeat(64) }); // 64 chars, but not hex
      expect(() => migrate.verifyCurrentWorkItemSchema(fresh)).toThrow(/Unsupported prerelease/);
    });
  });
});
