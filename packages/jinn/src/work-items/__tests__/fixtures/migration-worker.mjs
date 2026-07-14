const request = JSON.parse(process.argv[2]);

const Database = (await import("better-sqlite3")).default;
const {
  allocateWorkItemId,
  migrateWorkItemsSchema,
  useWorkItemAllocationClaim,
} = await import("../../../../dist/src/work-items/migrate.js");

process.send?.("ready");

process.on("message", (message) => {
  if (!message || typeof message !== "object" || (message.type !== "migrate" && message.type !== "allocate")) return;
  let db;
  try {
    db = new Database(message.path, { timeout: 10_000 });
    const result = migrateWorkItemsSchema(db);
    let id;
    if (message.type === "allocate") {
      const claim = allocateWorkItemId(db, message.now);
      useWorkItemAllocationClaim(db, claim, () => db.prepare(`
        INSERT INTO work_items (id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(claim.id, `worker-${message.worker}`, message.now, message.now));
      id = claim.id;
    }
    const integrity = db.pragma("integrity_check", { simple: true });
    const highWater = db
      .prepare("SELECT high_water FROM work_item_id_allocator WHERE singleton = 1")
      .pluck()
      .get();
    process.send?.({ round: message.round, ok: true, result, integrity, highWater, id });
  } catch (error) {
    process.send?.({
      round: message.round,
      ok: false,
      code: error && typeof error === "object" && "code" in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db?.close();
  }
});

process.once("disconnect", () => process.exit(0));
