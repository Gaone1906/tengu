import { describe, it, expect, afterAll } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  allocateWorkItemId,
  migrateWorkItemsSchema,
  preflightWorkItemsDatabase,
  useWorkItemAllocationClaim,
  verifyCurrentWorkItemSchema,
  UNSUPPORTED_PRERELEASE_TODO_DATA,
} from "../migrate.js";

/**
 * Startup classification for the first Todo release. There is no prerelease row
 * migration path: a home is created clean, replaced when it is a recognizably EMPTY
 * prerelease shell, verified when it is already current, or REFUSED — read-only, before
 * any write — in every other case. Converting real prerelease rows is the job of the
 * separate offline converter, never of startup.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-preflight-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
function dbPath(): string {
  seq += 1;
  return path.join(tmpRoot, `registry-${seq}.db`);
}

/** The unreleased `wi_*` shape, verbatim — the only prerelease table startup recognizes. */
const PRERELEASE_DDL = `
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department TEXT, assignee TEXT, priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank REAL, version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref TEXT, acceptance TEXT, verify_policy TEXT, rounds INTEGER NOT NULL DEFAULT 0, budget_usd REAL,
  approval_state TEXT CHECK (approval_state IN ('pending','approved','rejected')), approval_request TEXT, approval_ref TEXT,
  approval_target TEXT, approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT, approval_decided_by TEXT, approval_decided_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
)`;

const PRERELEASE_ROW = `INSERT INTO work_items (id, title, status, source, created_at, updated_at)
  VALUES ('wi_0123456789ab', 'a real prerelease todo', 'backlog', 'human', 'x', 'x')`;

/** Writes a file-backed database and closes it, as startup finds it on disk. */
function seedDb(sql?: string): string {
  const file = dbPath();
  const db = new Database(file);
  if (sql) db.exec(sql);
  else db.exec("CREATE TABLE placeholder (id TEXT)");
  db.close();
  return file;
}

function currentDb(): string {
  const file = dbPath();
  const db = new Database(file);
  migrateWorkItemsSchema(db, "absent");
  db.close();
  return file;
}

describe("startup Todo preflight — classification", () => {
  it("creates the clean company-prefix schema for a home with no Todo tables", () => {
    const file = seedDb();

    const db = new Database(file);
    migrateWorkItemsSchema(db, preflightWorkItemsDatabase(file));

    expect(() => verifyCurrentWorkItemSchema(db)).not.toThrow();
    expect(db.prepare("SELECT high_water FROM work_item_id_allocator WHERE singleton = 1").pluck().get()).toBe(0);
    db.close();
  });

  it("replaces a recognized prerelease shape when it and every companion table are empty", () => {
    const file = seedDb(`${PRERELEASE_DDL};
      CREATE TABLE work_item_events (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, work_item_id TEXT);`);

    expect(preflightWorkItemsDatabase(file)).toBe("empty-prerelease");

    const db = new Database(file);
    const result = migrateWorkItemsSchema(db, "empty-prerelease");

    expect(result.rebuilt).toBe(true);
    expect(() => verifyCurrentWorkItemSchema(db)).not.toThrow();
    // The replacement is real: the old grammar can no longer be written.
    expect(() => db.prepare(
      "INSERT INTO work_items (id, title, created_at, updated_at) VALUES ('wi_0123456789ab', 't', 'x', 'x')",
    ).run()).toThrow();
    db.close();
  });

  it("verifies an already-current schema without rebuilding it", () => {
    const file = currentDb();

    expect(preflightWorkItemsDatabase(file)).toBe("current");

    const db = new Database(file);
    expect(migrateWorkItemsSchema(db, "current")).toEqual({ rebuilt: false, rows: 0 });
    expect(() => verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("reclassifies under the write lock before acting on a stale empty-prerelease result", () => {
    const file = seedDb(PRERELEASE_DDL);
    const stalePreflight = preflightWorkItemsDatabase(file);
    expect(stalePreflight).toBe("empty-prerelease");

    const winner = new Database(file);
    migrateWorkItemsSchema(winner, stalePreflight);
    const claim = allocateWorkItemId(winner, "2026-07-14T00:00:00.000Z");
    useWorkItemAllocationClaim(winner, claim, () => winner.prepare(`
      INSERT INTO work_items (id, title, created_at, updated_at)
      VALUES (?, 'must survive stale startup', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `).run(claim.id));
    winner.close();

    const staleStarter = new Database(file);
    expect(migrateWorkItemsSchema(staleStarter, stalePreflight)).toEqual({ rebuilt: false, rows: 0 });
    expect(staleStarter.prepare("SELECT title FROM work_items WHERE id = 'JIN-1'").pluck().get())
      .toBe("must survive stale startup");
    staleStarter.close();
  });
});

describe("startup Todo preflight — refusal", () => {
  it("refuses populated prerelease data and writes nothing", () => {
    const file = seedDb(`${PRERELEASE_DDL}; ${PRERELEASE_ROW}`);
    const before = fs.readFileSync(file);

    expect(() => preflightWorkItemsDatabase(file)).toThrow(UNSUPPORTED_PRERELEASE_TODO_DATA);

    // Read-only and side-effect free: the row survives, no identity table was created,
    // and the file is byte-identical.
    const db = new Database(file);
    expect(db.prepare("SELECT COUNT(*) FROM work_items").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'work_item_id_allocator'").pluck().get()).toBe(0);
    db.close();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses a prerelease shell whose companion table still holds rows", () => {
    const file = seedDb(`${PRERELEASE_DDL};
      CREATE TABLE work_item_events (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL);
      INSERT INTO work_item_events (id, work_item_id) VALUES ('e1', 'wi_0123456789ab');`);

    expect(() => preflightWorkItemsDatabase(file)).toThrow(UNSUPPORTED_PRERELEASE_TODO_DATA);
  });

  it("refuses a current schema whose immutable-ID trigger was dropped", () => {
    const file = currentDb();
    const tamper = new Database(file);
    tamper.exec("DROP TRIGGER work_items_id_immutable");
    tamper.close();

    expect(() => preflightWorkItemsDatabase(file)).toThrow(UNSUPPORTED_PRERELEASE_TODO_DATA);
  });

  it("refuses an unknown Todo schema it cannot classify", () => {
    const file = seedDb(`CREATE TABLE work_items (id TEXT PRIMARY KEY, headline TEXT);
      INSERT INTO work_items (id, headline) VALUES ('anything', 'foreign shape');`);

    expect(() => preflightWorkItemsDatabase(file)).toThrow(UNSUPPORTED_PRERELEASE_TODO_DATA);
  });

  it("refuses without echoing any of the data it refused", () => {
    const file = seedDb(`${PRERELEASE_DDL}; ${PRERELEASE_ROW}`);

    const message = (() => {
      try {
        preflightWorkItemsDatabase(file);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    expect(message).toBe(UNSUPPORTED_PRERELEASE_TODO_DATA);
    expect(message).not.toMatch(/wi_0123456789ab|a real prerelease todo/);
  });
});

/* ── Concurrent first boot ───────────────────────────────────────────────────
 * Several gateway processes can open the same fresh home at once and all classify it
 * as absent. Re-running the identity DDL must be a no-op, not an abort against the
 * allocator's own immutability trigger. */

interface MigrationWorkerResult {
  round: number;
  ok: boolean;
  code?: string;
  message?: string;
  integrity?: string;
  highWater?: number;
  id?: string;
}

function startMigrationWorker(): { child: ChildProcess; ready: Promise<void> } {
  const worker = fileURLToPath(new URL("./fixtures/migration-worker.mjs", import.meta.url));
  const child = fork(worker, [JSON.stringify({ worker: true })], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const ready = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`migration worker exited ${code}: ${stderr}`));
    });
    const onMessage = (message: unknown) => {
      if (message === "ready") {
        child.off("message", onMessage);
        resolve();
      }
    };
    child.on("message", onMessage);
  });
  return { child, ready };
}

function runMigrationWave(
  children: ChildProcess[],
  file: string,
  round: number,
  type: "migrate" | "allocate" = "migrate",
  companyNames?: string[],
): Promise<MigrationWorkerResult[]> {
  return Promise.all(children.map((child, worker) => new Promise<MigrationWorkerResult>((resolve, reject) => {
    const onError = (error: Error) => {
      child.off("message", onMessage);
      reject(error);
    };
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && "round" in message && message.round === round) {
        child.off("message", onMessage);
        child.off("error", onError);
        resolve(message as MigrationWorkerResult);
      }
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.send({
      type,
      path: file,
      round,
      worker,
      companyName: companyNames?.[worker],
      now: `2026-07-14T00:00:${String(worker).padStart(2, "0")}.000Z`,
    });
  })));
}

describe("startup Todo preflight — concurrent first boot", () => {
  it("lets 16 processes migrate one fresh home without aborting or double-seeding", async () => {
    const file = seedDb();
    const workers = Array.from({ length: 16 }, () => startMigrationWorker());
    await Promise.all(workers.map((worker) => worker.ready));

    try {
      const results = await runMigrationWave(workers.map((w) => w.child), file, 1);

      expect(results.filter((result) => !result.ok)).toEqual([]);
      expect(results.every((result) => result.integrity === "ok")).toBe(true);
      expect(results.every((result) => result.highWater === 0)).toBe(true);
    } finally {
      for (const worker of workers) worker.child.disconnect();
    }

    const db = new Database(file);
    expect(db.prepare("SELECT COUNT(*) FROM work_item_id_allocator").pluck().get()).toBe(1);
    expect(() => verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  }, 30_000);

  it("lets 32 processes allocate distinct monotonic ids without reuse", async () => {
    const file = currentDb();
    const workers = Array.from({ length: 32 }, () => startMigrationWorker());
    await Promise.all(workers.map((worker) => worker.ready));

    try {
      const companyNames = Array.from({ length: 32 }, (_, index) => index % 2 === 0 ? "IC-IDEV" : "Acme Labs");
      const results = await runMigrationWave(workers.map((worker) => worker.child), file, 2, "allocate", companyNames);
      expect(results.filter((result) => !result.ok)).toEqual([]);
      expect(new Set(results.map((result) => result.id)).size).toBe(32);
      const prefixes = new Set(results.map((result) => result.id?.slice(0, 3)));
      expect(prefixes.size).toBe(1);
      const [prefix] = [...prefixes];
      expect(["ICI", "ACM"]).toContain(prefix);
      expect(results.map((result) => result.id).sort((a, b) => Number(a?.slice(4)) - Number(b?.slice(4))))
        .toEqual(Array.from({ length: 32 }, (_, index) => `${prefix}-${index + 1}`));
    } finally {
      for (const worker of workers) worker.child.disconnect();
    }

    const db = new Database(file);
    expect(db.prepare("SELECT high_water FROM work_item_id_allocator WHERE singleton = 1").pluck().get()).toBe(32);
    expect(db.prepare("SELECT COUNT(*) FROM work_item_id_burns").pluck().get()).toBe(32);
    expect(db.prepare("SELECT COUNT(*) FROM work_item_id_issuances").pluck().get()).toBe(32);
    expect(db.prepare("SELECT COUNT(*) FROM work_items").pluck().get()).toBe(32);
    expect(() => verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  }, 30_000);
});
