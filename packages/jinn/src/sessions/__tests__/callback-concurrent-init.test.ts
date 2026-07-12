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
});
