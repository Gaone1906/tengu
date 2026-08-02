import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-msg-page-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Reg = typeof import("../registry.js");
let reg: Reg;

function insertSession(id: string) {
  const db = dbModule.initDb();
  db.prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude', 'web', ?, 'idle', 't', 't')",
  ).run(id, `web:${id}`);
}

function insertMessage(id: string, content: string, timestamp: number, seq: number | null = null) {
  const db = dbModule.initDb();
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, timestamp, seq) VALUES (?, 's-page', 'assistant', ?, ?, ?)",
  ).run(id, content, timestamp, seq);
}

beforeAll(async () => {
  reg = await import("../registry.js");
  dbModule.initDb();
  insertSession("s-page");
  insertMessage("m1", "one", 1000);
  insertMessage("m2", "two", 2000);
  insertMessage("m3", "three", 3000);
  insertMessage("m4", "four", 4000);
  insertMessage("m5", "five", 5000);
  insertMessage("m6", "six-a", 6000, 1);
  insertMessage("m7", "six-b", 6000, 2);
});

describe("getMessagePage", () => {
  it("returns the newest messages in ascending render order", () => {
    const page = reg.getMessagePage("s-page", { limit: 3 });

    expect(page.messages.map((m) => m.id)).toEqual(["m5", "m6", "m7"]);
    expect(page.hasOlder).toBe(true);
  });

  it("returns messages before a cursor while preserving render order", () => {
    const page = reg.getMessagePage("s-page", { before: "m5", limit: 2 });

    expect(page.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
    expect(page.hasOlder).toBe(true);
  });

  it("reports no older page when the cursor reaches the beginning", () => {
    const page = reg.getMessagePage("s-page", { before: "m3", limit: 2 });

    expect(page.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(page.hasOlder).toBe(false);
  });

  it("returns an empty page for an unknown cursor", () => {
    const page = reg.getMessagePage("s-page", { before: "missing", limit: 2 });

    expect(page.messages).toEqual([]);
    expect(page.hasOlder).toBe(false);
  });
});
