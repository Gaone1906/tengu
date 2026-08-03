import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pins-"));
process.env.JINN_HOME = home;
const dbModule = await import("../../shared/db.js");

type Registry = typeof import("../registry.js");
let registry: Registry;

beforeAll(async () => {
  registry = await import("../registry.js");
  dbModule.initDb();
});

describe("chat pins", () => {
  it("stores session and employee pins idempotently", () => {
    const session = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:session-a",
    });
    registry.pinChat(session.id);
    registry.pinChat(session.id);
    registry.pinChat("emp:research");

    expect(registry.listChatPins().map((pin) => pin.key)).toEqual(
      expect.arrayContaining([session.id, "emp:research"]),
    );
    expect(registry.listChatPins()).toHaveLength(2);

    registry.unpinChat(session.id);
    registry.unpinChat(session.id);
    expect(registry.listChatPins().map((pin) => pin.key)).toEqual(["emp:research"]);
  });

  it("returns only pinned non-archived sessions newest first", () => {
    const older = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:pinned-older",
    });
    const newer = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:pinned-newer",
    });
    const archived = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:pinned-archived",
    });
    const unpinned = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:unpinned",
    });
    const database = dbModule.initDb();
    database.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", older.id);
    database.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", newer.id);
    database.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run("2026-01-03T00:00:00.000Z", archived.id);
    registry.pinChat(older.id);
    registry.pinChat(newer.id);
    registry.pinChat(archived.id);
    registry.archiveSession(archived.id);

    expect(registry.listPinnedSessions().map((session) => session.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect(registry.listPinnedSessions().map((session) => session.id)).not.toContain(unpinned.id);
  });

  it("deleting sessions removes their pin rows in the same transaction", () => {
    const single = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:pinned-delete-single",
    });
    const bulk = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:pinned-delete-bulk",
    });
    registry.pinChat(single.id);
    registry.pinChat(bulk.id);

    expect(registry.deleteSession(single.id)).toBe(true);
    expect(registry.deleteSessions([bulk.id])).toBe(1);

    const database = dbModule.initDb();
    const rows = database
      .prepare("SELECT pin_key FROM chat_pins WHERE pin_key IN (?, ?)")
      .all(single.id, bulk.id);
    expect(rows).toEqual([]);
    expect(registry.listChatPins().map((pin) => pin.key)).not.toEqual(
      expect.arrayContaining([single.id, bulk.id]),
    );
  });

  it("creates chat_pins when opening a database that predates the table", () => {
    const database = dbModule.initDb();
    database.exec("DROP TABLE chat_pins");
    dbModule.__closeDbForTest();

    const reopened = dbModule.initDb();
    const table = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_pins'")
      .get();
    expect(table).toEqual({ name: "chat_pins" });
  });
});
