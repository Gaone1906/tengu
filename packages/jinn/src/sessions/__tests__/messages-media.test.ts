import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-media-"));
process.env.JINN_HOME = tmp;
const migrateModule = await import("../migrate.js");
const dbModule = await import("../../shared/db.js");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
});

describe("messages.media column", () => {
  it("adds a nullable media column on init", () => {
    const db = dbModule.initDb();
    const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("media");
    expect(cols.map((c) => c.name)).toContain("meta");
  });

  it("round-trips media as parsed JSON, defaulting to undefined", () => {
    const db = dbModule.initDb();
    // a plain message has no media
    db.prepare(
      "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES ('s1','claude','web','web:s1','idle','t','t')",
    ).run();
    reg.insertMessage("s1", "user", "hello");
    const media = [{ type: "image" as const, url: "/api/files/abc", name: "chart.png" }];
    reg.insertMessage("s1", "assistant", "here is a chart", media);

    const msgs = reg.getMessages("s1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].media).toBeUndefined();
    expect(msgs[1].media).toEqual(media);
  });

  it("round-trips structured notification metadata", () => {
    const meta = {
      kind: "child-reply",
      employee: "design-lead",
      childSessionId: "child-123",
    };
    reg.insertMessage("s1", "notification", "A teammate replied", undefined, undefined, undefined, meta);

    expect(reg.getMessages("s1").at(-1)).toMatchObject({ meta });
  });

  it("migrates an existing message DB that predates the media column", () => {
    // Build a legacy DB by hand (no media column), then run the migration.
    const legacyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-legacy-")), "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.exec(
      "CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL)",
    );
    legacy.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m1','s','user','old',1)",
    ).run();

    migrateModule.migrateMessagesSchema(legacy);

    const cols = legacy.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("media");
    expect(cols.map((c) => c.name)).toContain("meta");
    // existing row preserved, media null
    const row = legacy.prepare("SELECT content, media FROM messages WHERE id='m1'").get() as {
      content: string;
      media: string | null;
    };
    expect(row.content).toBe("old");
    expect(row.media).toBeNull();
    legacy.close();
  });

  it("duplicateSession copies message media", () => {
    const db = dbModule.initDb();
    db.prepare(
      "INSERT INTO sessions (id, engine, engine_session_id, source, source_ref, status, created_at, last_activity) VALUES ('src','claude','eng-1','web','web:src','idle','t','t')",
    ).run();
    const media = [{ type: "file" as const, url: "/api/files/xyz", name: "report.pdf" }];
    reg.insertMessage("src", "assistant", "doc", media);

    const { session } = reg.duplicateSession("src");
    const copied = reg.getMessages(session.id);
    expect(copied[0].media).toEqual(media);
  });
});
