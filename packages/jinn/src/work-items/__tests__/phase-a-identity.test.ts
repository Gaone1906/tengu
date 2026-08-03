import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-phase-a-id-"));
process.env.JINN_HOME = home;

type Store = typeof import("../store.js");
type Registry = typeof import("../../sessions/registry.js");

let store: Store;
let registry: Registry;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  registry = await import("../../sessions/registry.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("Phase A Todo identity", () => {
  it("issues the sole public identity from a monotonic JIN allocator", () => {
    const first = store.createWorkItem({ title: "first" });
    const second = store.createWorkItem({ title: "second" });

    expect(first.id).toBe("JIN-1");
    expect(second.id).toBe("JIN-2");
    expect(db.prepare("SELECT high_water FROM work_item_id_allocator WHERE prefix = 'JIN'").pluck().get()).toBe(2);
    expect(db.prepare("SELECT ordinal FROM work_item_id_burns ORDER BY ordinal").pluck().all()).toEqual([1, 2]);
    expect(db.prepare("SELECT ordinal FROM work_item_id_issuances ORDER BY ordinal").pluck().all()).toEqual([1, 2]);
  });

  it("makes the primary key immutable even for a same-value update", () => {
    const item = store.createWorkItem({ title: "immutable" });

    expect(() => db.prepare("UPDATE work_items SET id = ? WHERE id = ?").run(item.id, item.id)).toThrow(/immutable/i);
    expect(() => db.prepare("UPDATE work_items SET id = 'JIN-999' WHERE id = ?").run(item.id)).toThrow(/immutable/i);
    expect(store.getWorkItem(item.id)?.title).toBe("immutable");
  });

  it("rejects prerelease and malformed ids before lookup", () => {
    for (const id of ["wi_0123456789ab", "JIN-0", "JIN-01", "jin-1", " JIN-1", "JIN-9007199254740992"]) {
      expect(() => store.getWorkItem(id)).toThrow(/Todo ID/i);
    }
  });

  it("rejects malformed ids at direct store and session boundaries before effects", () => {
    const session = registry.createSession({ engine: "codex", source: "web", sourceRef: "web:phase-a-boundary" });
    const before = registry.getSession(session.id);

    for (const id of ["wi_0123456789ab", "JIN-0", "JIN-01", "garbage"]) {
      expect(() => store.appendWorkItemEvent({ workItemId: id, kind: "note" })).toThrow(/Todo ID/i);
      expect(() => store.listWorkItemEvents(id)).toThrow(/Todo ID/i);
      expect(() => store.getWorkItemSpend(id)).toThrow(/Todo ID/i);
      expect(() => store.linkSession(id, session.id)).toThrow(/Todo ID/i);
      expect(() => registry.listSessionsByWorkItem(id)).toThrow(/Todo ID/i);
      expect(() => registry.claimDelegationCompletionNudge(session.id, id)).toThrow(/Todo ID/i);
      expect(() => registry.markDelegationCompletionSurfaced(session.id, id)).toThrow(/Todo ID/i);
      expect(() => registry.releaseDelegationCompletionNudge(session.id, id)).toThrow(/Todo ID/i);
      expect(() => registry.clearDelegationCompletionGuard(session.id, id)).toThrow(/Todo ID/i);
    }

    expect(registry.getSession(session.id)).toEqual(before);
  });

  it("searches by the exact public Todo id", () => {
    const target = store.createWorkItem({ title: "identity search target" });
    store.createWorkItem({ title: `mentions ${target.id} without owning it` });

    expect(store.queryWorkItems({ text: target.id }).workItems.map((item) => item.id)).toContain(target.id);
  });
});
