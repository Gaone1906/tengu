const request = JSON.parse(process.argv[2]);

const Database = (await import("better-sqlite3")).default;
const { migrateWorkItemsSchema } = await import("../../../../dist/src/work-items/migrate.js");

process.send?.("ready");

process.on("message", (message) => {
  if (!message || typeof message !== "object" || message.type !== "migrate") return;
  let db;
  try {
    db = new Database(message.path, { timeout: 10_000 });
    const result = migrateWorkItemsSchema(db);
    const integrity = db.pragma("integrity_check", { simple: true });
    const version = db
      .prepare("SELECT version FROM work_items WHERE id = 'wi_versionless'")
      .pluck()
      .get();
    process.send?.({ round: message.round, ok: true, result, integrity, version });
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
