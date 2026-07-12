import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "fixtures", "callback-open-worker.mjs");
const registryPath = path.resolve(here, "../../../dist/src/sessions/registry.js");
const PROCESS_COUNT = 16;

interface WorkerResult {
  commonId: string;
  distinctId: string;
}

function runWorker(home: string, wave: string, index: number): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, home, registryPath, wave, String(index)], {
      env: { ...process.env, JINN_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`callback init worker ${wave}/${index} exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout) as WorkerResult);
    });
  });
}

async function runWave(home: string, wave: string): Promise<WorkerResult[]> {
  return Promise.all(Array.from({ length: PROCESS_COUNT }, (_, index) => runWorker(home, wave, index)));
}

function seedExactChildSpecificSchema(home: string): void {
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const database = new Database(path.join(sessions, "registry.db"));
  database.function("jinn_callback_identity", { deterministic: true }, (value: unknown) => value);
  database.exec(`
    CREATE TABLE callback_deliveries (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL CHECK (length(parent_session_id) > 0 AND parent_session_id = jinn_callback_identity(parent_session_id)),
      child_session_id TEXT NOT NULL CHECK (length(child_session_id) > 0 AND child_session_id = jinn_callback_identity(child_session_id)),
      attempt_token TEXT NOT NULL CHECK (length(attempt_token) > 0 AND attempt_token = jinn_callback_identity(attempt_token)),
      terminal_outcome TEXT NOT NULL CHECK (length(terminal_outcome) > 0 AND terminal_outcome = jinn_callback_identity(terminal_outcome)),
      terminal_version INTEGER NOT NULL CHECK (terminal_version >= 1),
      callback_kind TEXT NOT NULL CHECK (length(callback_kind) > 0 AND callback_kind = jinn_callback_identity(callback_kind)),
      payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object' AND json_type(payload, '$.message') IS 'text' AND json_type(payload, '$.displayMessage') IS 'text'),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dead_letter')),
      message_id TEXT,
      queue_item_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER,
      last_attempt_at INTEGER,
      last_error TEXT,
      dead_lettered_at INTEGER,
      created_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE UNIQUE INDEX uq_callback_delivery_identity ON callback_deliveries (
      parent_session_id, child_session_id, attempt_token, terminal_outcome, terminal_version, callback_kind
    );
    CREATE INDEX idx_callback_deliveries_pending ON callback_deliveries (status, next_attempt_at, created_at) WHERE status = 'pending';
  `);
  database.prepare(`
    INSERT INTO callback_deliveries (
      id, parent_session_id, child_session_id, attempt_token, terminal_outcome,
      terminal_version, callback_kind, payload, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    "legacy-delivery",
    "legacy-parent",
    "legacy-child",
    "legacy-attempt",
    "succeeded",
    1,
    "parent-completion",
    JSON.stringify({ message: "legacy", displayMessage: "Legacy" }),
    "2026-07-12T00:00:00.000Z",
  );
  database.close();
}

describe("callback delivery concurrent process initialization", () => {
  it("serializes fresh and existing-home opens without SQLITE_BUSY or duplicate identities", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-callback-process-race-"));

    const fresh = await runWave(home, "fresh");
    expect(new Set(fresh.map((result) => result.commonId))).toHaveLength(1);
    expect(new Set(fresh.map((result) => result.distinctId))).toHaveLength(PROCESS_COUNT);

    const existing = await runWave(home, "existing");
    expect(new Set(existing.map((result) => result.commonId))).toHaveLength(1);
    expect(new Set(existing.map((result) => result.distinctId))).toHaveLength(PROCESS_COUNT);

    const database = new Database(path.join(home, "sessions", "registry.db"), { readonly: true });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM callback_deliveries
      WHERE source_attempt IN ('attempt-fresh', 'attempt-existing')
    `).get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM callback_deliveries").get())
      .toEqual({ count: 2 + (PROCESS_COUNT * 2) });
    const identityIndex = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_callback_delivery_identity'
    `).get() as { sql: string };
    expect(identityIndex.sql).toMatch(/CREATE UNIQUE INDEX uq_callback_delivery_identity/i);
    database.close();
  }, 30_000);

  it("serializes concurrent opens and one transactional migration from the actual child-specific schema", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-callback-legacy-process-race-"));
    seedExactChildSpecificSchema(home);

    const migrated = await runWave(home, "legacy");
    expect(new Set(migrated.map((result) => result.commonId))).toHaveLength(1);
    expect(new Set(migrated.map((result) => result.distinctId))).toHaveLength(PROCESS_COUNT);

    const database = new Database(path.join(home, "sessions", "registry.db"), { readonly: true });
    expect(database.prepare(`
      SELECT id, target_session_id AS targetSessionId, source_kind AS sourceKind,
        source_id AS sourceId, source_attempt AS sourceAttempt, status, created_at AS createdAt
      FROM callback_deliveries WHERE id = 'legacy-delivery'
    `).get()).toEqual({
      id: "legacy-delivery",
      targetSessionId: "legacy-parent",
      sourceKind: "session",
      sourceId: "legacy-child",
      sourceAttempt: "legacy-attempt",
      status: "pending",
      createdAt: "2026-07-12T00:00:00.000Z",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM callback_deliveries").get())
      .toEqual({ count: 1 + 1 + PROCESS_COUNT });
    database.close();
  }, 30_000);
});
