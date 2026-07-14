import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { buildTodoMapping, inventoryDatabase } from "../inventory.mjs";

const require = createRequire(new URL("../../../packages/jinn/package.json", import.meta.url));
const Database = require("better-sqlite3");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-prerelease-converter-"));
  const databasePath = path.join(root, "sessions.db");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE work_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, created_at TEXT NOT NULL);
    CREATE TABLE work_item_events (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, detail TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, work_item_id TEXT, source_ref TEXT, transport_meta TEXT, title TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, blocks TEXT);
    CREATE TABLE callback_deliveries (id TEXT PRIMARY KEY, payload TEXT, message_id TEXT, queue_item_id TEXT);
    CREATE TABLE queue_items (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL);
    CREATE TABLE activity_events (
      seq INTEGER PRIMARY KEY, id TEXT DEFAULT 'act', story_id TEXT DEFAULT 'story', occurred_at TEXT DEFAULT '2026-07-14T00:00:00.000Z',
      kind TEXT DEFAULT 'todo', action TEXT DEFAULT 'updated', actor_type TEXT DEFAULT 'system', actor_id TEXT DEFAULT 'system',
      actor_display_name TEXT DEFAULT 'System', object_type TEXT DEFAULT 'todo', object_id TEXT, object_label TEXT DEFAULT 'Todo',
      object_href TEXT, outcome_state TEXT DEFAULT 'info', outcome_label TEXT DEFAULT 'Info', summary TEXT,
      correlation_id TEXT DEFAULT 'todo:test:fixture', causation_id TEXT, root_event_id TEXT, attempt INTEGER,
      idempotency_key TEXT, detail_ref TEXT, detail_json TEXT, links_json TEXT, payload_hash TEXT DEFAULT 'hash'
    );
    CREATE TABLE activity_stories (
      story_id TEXT PRIMARY KEY, latest_event_id TEXT, latest_seq INTEGER, last_append_seq INTEGER, occurred_at TEXT,
      event_count INTEGER, kind TEXT, outcome_state TEXT
    );
    CREATE TABLE activity_story_versions (
      story_id TEXT, append_seq INTEGER, latest_event_id TEXT, latest_seq INTEGER, occurred_at TEXT,
      event_count INTEGER, kind TEXT, outcome_state TEXT, PRIMARY KEY (story_id, append_seq)
    );
    CREATE VIRTUAL TABLE activity_event_search USING fts5(event_id UNINDEXED, story_id UNINDEXED, seq UNINDEXED, search_text);
  `);
  const first = "wi_00000000000a";
  const second = "wi_00000000000b";
  db.prepare("INSERT INTO work_items VALUES (?, ?, ?, ?)").run(second, "Second", "literal wi_00000000000a prose", "2026-07-14T00:00:00.000Z");
  db.prepare("INSERT INTO work_items VALUES (?, ?, ?, ?)").run(first, "First", null, "2026-07-14T00:00:00.000Z");
  db.prepare("INSERT INTO work_item_events VALUES ('e1', ?, ?)").run(first, JSON.stringify({ todoId: first }));
  db.prepare("INSERT INTO sessions VALUES ('s1', ?, ?, ?, ?)").run(
    second,
    `delegation:${second}`,
    JSON.stringify({ delegationCompletionContract: { workItemId: second } }),
    `authored prose ${first}`,
  );
  db.prepare("INSERT INTO messages VALUES (?, 's1', ?, ?, ?)").run(
    `block-dg-${second}-nonce`,
    `authored prose ${first}`,
    JSON.stringify({ workItemId: second }),
    JSON.stringify([{ id: `dg-${second}`, payload: { todoId: second } }]),
  );
  db.prepare("INSERT INTO callback_deliveries VALUES ('cb1', ?, ?, ?)").run(
    JSON.stringify({ workItemId: second }),
    `block-dg-${second}-nonce`,
    `delegation:${second}`,
  );
  db.prepare("INSERT INTO queue_items VALUES (?, 's1', ?)").run(`delegation:${second}`, `terminal prose ${first}`);
  db.close();
  return { root, databasePath, first, second };
}

test("maps legacy Todos deterministically by created_at then binary id without exposing raw values", () => {
  const { root, databasePath, first, second } = fixture();
  try {
    const db = new Database(databasePath, { readonly: true });
    const mapping = buildTodoMapping(db, "ICI");
    db.close();
    assert.deepEqual([...mapping], [[first, "ICI-1"], [second, "ICI-2"]]);

    const before = fs.readFileSync(databasePath);
    const report = inventoryDatabase({ databasePath });
    assert.equal(report.ok, true);
    assert.equal(report.todoCount, 2);
    assert.deepEqual(report.blockers, []);
    assert.doesNotMatch(JSON.stringify(report), /wi_[0-9a-f]{12}/);
    assert.ok(fs.readFileSync(databasePath).equals(before));
    assert.deepEqual(inventoryDatabase({ databasePath }), report);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a non-canonical company prefix before reading Todo rows", () => {
  const { root, databasePath } = fixture();
  try {
    const db = new Database(databasePath, { readonly: true });
    assert.throws(() => buildTodoMapping(db, "IC"), /three uppercase Latin letters/);
    assert.throws(() => buildTodoMapping(db, "ici"), /three uppercase Latin letters/);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses orphan structured references with digest-only diagnostics", () => {
  const { root, databasePath } = fixture();
  try {
    const db = new Database(databasePath);
    db.prepare("INSERT INTO work_item_events VALUES ('orphan', 'wi_00000000000f', NULL)").run();
    db.close();

    const report = inventoryDatabase({ databasePath });
    assert.equal(report.ok, false);
    assert.equal(report.blockers.some((entry) => entry.code === "orphan-todo-reference"), true);
    assert.doesNotMatch(JSON.stringify(report), /wi_[0-9a-f]{12}/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Activity remains a zero-affected-row refusal gate while free-form prose stays inert", () => {
  const { root, databasePath, first } = fixture();
  try {
    let db = new Database(databasePath);
    db.prepare("INSERT INTO activity_events (seq, object_id, summary, detail_json, links_json) VALUES (1, NULL, ?, ?, '[]')").run(
      `free-form ${first}`,
      JSON.stringify({ note: `free-form ${first}` }),
    );
    db.close();
    assert.equal(inventoryDatabase({ databasePath }).ok, true);

    db = new Database(databasePath);
    db.prepare("INSERT INTO activity_events (seq, object_id, summary, detail_json, links_json) VALUES (2, ?, 'safe', '{}', '[]')").run(first);
    db.close();
    const report = inventoryDatabase({ databasePath });
    assert.equal(report.ok, false);
    assert.equal(report.blockers.some((entry) => entry.code === "activity-todo-reference"), true);
    assert.doesNotMatch(JSON.stringify(report), /wi_[0-9a-f]{12}/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Activity validates the exact projection schema and every structured scalar or nested path", () => {
  const { root, databasePath, first } = fixture();
  try {
    let db = new Database(databasePath);
    db.prepare(`INSERT INTO activity_events
      (seq, object_id, causation_id, summary, detail_json, links_json)
      VALUES (1, 'safe', ?, ?, ?, ?)`)
      .run(first, `free-form ${first}`, JSON.stringify({ note: `free-form ${first}` }), JSON.stringify([{ label: "open", href: `/todos/${first}` }]));
    db.close();
    let report = inventoryDatabase({ databasePath });
    assert.equal(report.ok, false);
    assert.equal(report.blockers.filter((entry) => entry.code === "activity-todo-reference").length >= 2, true, JSON.stringify(report.blockers));
    assert.doesNotMatch(JSON.stringify(report), /wi_[0-9a-f]{12}/);

    db = new Database(databasePath);
    db.exec("ALTER TABLE activity_stories ADD COLUMN unexpected_private_projection TEXT");
    db.close();
    report = inventoryDatabase({ databasePath });
    assert.equal(report.blockers.some((entry) => entry.code === "activity-schema-mismatch"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses unclassified structured copies and partial accepted callback projections", () => {
  const { root, databasePath, first } = fixture();
  try {
    let db = new Database(databasePath);
    db.exec("CREATE TABLE unknown_extension (id INTEGER PRIMARY KEY, todo_pointer TEXT)");
    db.prepare("INSERT INTO unknown_extension VALUES (1, ?)").run(first);
    db.prepare("INSERT INTO callback_deliveries VALUES ('partial', ?, NULL, 'queue-missing')")
      .run(JSON.stringify({ workItemId: first }));
    db.close();

    const report = inventoryDatabase({ databasePath });
    assert.equal(report.ok, false);
    assert.equal(report.blockers.some((entry) => entry.code === "unclassified-todo-reference"), true);
    assert.equal(report.blockers.some((entry) => entry.code === "partial-callback-projection"), true);
    assert.doesNotMatch(JSON.stringify(report), /wi_[0-9a-f]{12}/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
