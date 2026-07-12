import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-cas-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type UpdateWorkItemInput = import("../store.js").UpdateWorkItemInput;
type Registry = typeof import("../../sessions/registry.js");
let store: Store;
let registry: Registry;

beforeAll(async () => {
  store = await import("../store.js");
  registry = await import("../../sessions/registry.js");
});

function conditional(
  id: string,
  patch: UpdateWorkItemInput,
  expectedVersion: number,
  idempotencyKey?: string,
) {
  return store.updateWorkItemConditional(id, patch, {
    expectedVersion,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    actor: "operator",
  });
}

interface WorkerRequest {
  home: string;
  id: string;
  expectedVersion: number;
  title: string;
  idempotencyKey: string;
}

interface WorkerResult {
  ok: boolean;
  version?: number;
  replayed?: boolean;
  errorName?: string;
  currentVersion?: number;
}

function startWorker(request: WorkerRequest): Promise<{ child: ChildProcess; ready: Promise<void>; result: Promise<WorkerResult> }> {
  const worker = fileURLToPath(new URL("./fixtures/cas-worker.mjs", import.meta.url));
  const child = fork(worker, [JSON.stringify(request)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    const onMessage = (message: unknown) => {
      if (message === "ready") {
        child.off("message", onMessage);
        resolve();
      }
    };
    child.on("message", onMessage);
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("message", (message: unknown) => {
      if (message && typeof message === "object" && "ok" in message) resolve(message as WorkerResult);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`CAS worker exited ${code}: ${stderr}`));
    });
  });
  return Promise.resolve({ child, ready, result });
}

describe("conditional Todo metadata updates", () => {
  it("allows exactly one of two same-version writes and reports the current version on the loser", () => {
    const item = store.createWorkItem({ title: "base" });
    const first = conditional(item.id, { title: "winner" }, item.version, "cas:two:first");

    expect(first).toMatchObject({ item: { title: "winner", version: 2 }, replayed: false });
    expect(() => conditional(item.id, { title: "loser" }, item.version, "cas:two:second")).toThrowError(
      expect.objectContaining({ name: "WorkItemVersionConflictError", currentVersion: 2 }),
    );
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "winner", version: 2 });
  });

  it("uses row-level CAS for unrelated field patches without silently merging", () => {
    const item = store.createWorkItem({ title: "base", priority: 1 });
    conditional(item.id, { title: "remote title" }, item.version, "cas:unrelated:title");

    expect(() => conditional(item.id, { priority: 3 }, item.version, "cas:unrelated:priority")).toThrowError(
      expect.objectContaining({ name: "WorkItemVersionConflictError", currentVersion: 2 }),
    );
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "remote title", priority: 1, version: 2 });
  });

  it("does not bump version or audit for an exact no-op at the current version", () => {
    const item = store.createWorkItem({ title: "same" });
    const beforeEvents = store.listWorkItemEvents(item.id).length;

    const result = conditional(item.id, { title: "same" }, item.version, "cas:noop:one");

    expect(result).toMatchObject({ item: { version: 1 }, replayed: false });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(beforeEvents);
  });

  it("replays a committed request after a lost response without duplicate mutation, then permits a compensating conditional revert", () => {
    const item = store.createWorkItem({ title: "desired local" });
    const eventsBefore = store.listWorkItemEvents(item.id).length;

    conditional(item.id, { title: "committed upstream" }, item.version, "cas:lost-response:request");
    const replay = conditional(item.id, { title: "committed upstream" }, item.version, "cas:lost-response:request");

    expect(replay).toMatchObject({ item: { title: "committed upstream", version: 2 }, replayed: true });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore + 1);

    const current = store.getWorkItem(item.id)!;
    const compensated = conditional(current.id, { title: "desired local" }, current.version, "cas:lost-response:compensate");
    expect(compensated).toMatchObject({ item: { title: "desired local", version: 3 }, replayed: false });
  });

  it("rejects reuse of an idempotency key for different content without leaking the content", () => {
    const item = store.createWorkItem({ title: "base" });
    conditional(item.id, { title: "first" }, item.version, "cas:key-reuse:one");

    expect(() => conditional(item.id, { title: "private second value" }, item.version, "cas:key-reuse:one")).toThrowError(
      expect.objectContaining({ name: "WorkItemIdempotencyConflictError", currentVersion: 2 }),
    );
  });

  it("persists only a digest of the caller idempotency key", () => {
    const item = store.createWorkItem({ title: "digest receipt" });
    const key = "todo:edit:caller-private-key";
    conditional(item.id, { title: "digested" }, item.version, key);

    const receipt = registry.initDb().prepare("SELECT * FROM work_item_edit_receipts ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown>;
    expect(receipt.key_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(key);
  });

  it("persists idempotency receipts across a separate-process reopen", async () => {
    const item = store.createWorkItem({ title: "before reopen" });
    conditional(item.id, { title: "after reopen" }, item.version, "cas:restart:one");
    const worker = await startWorker({
      home: tmp,
      id: item.id,
      expectedVersion: item.version,
      title: "after reopen",
      idempotencyKey: "cas:restart:one",
    });
    await worker.ready;
    worker.child.send("go");

    await expect(worker.result).resolves.toMatchObject({ ok: true, version: 2, replayed: true });
    expect(store.getWorkItem(item.id)?.version).toBe(2);
  });

  it("has exactly one winner in a three-process same-version race", async () => {
    const item = store.createWorkItem({ title: "process race" });
    const workers = await Promise.all(["alpha", "beta", "gamma"].map((name) => startWorker({
      home: tmp,
      id: item.id,
      expectedVersion: item.version,
      title: name,
      idempotencyKey: `cas:process:${name}`,
    })));
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send("go");
    const results = await Promise.all(workers.map((worker) => worker.result));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok).every((result) =>
      result.errorName === "WorkItemVersionConflictError" && result.currentVersion === 2,
    )).toBe(true);
    expect(store.getWorkItem(item.id)?.version).toBe(2);
  });
});
