import type Database from "better-sqlite3";

export class ActivityCursorSecretError extends Error {
  constructor() {
    super("activity cursor secret is unavailable");
    this.name = "ActivityCursorSecretError";
  }
}

export function activityCursorSecret(database: Database.Database): Buffer {
  try {
    const row = database.prepare("SELECT value FROM activity_ledger_meta WHERE key = 'cursor_hmac_v1'").get() as { value: string } | undefined;
    if (!row || !/^[a-f0-9]{64}$/.test(row.value)) throw new ActivityCursorSecretError();
    return Buffer.from(row.value, "hex");
  } catch (error) {
    if (error instanceof ActivityCursorSecretError) throw error;
    throw new ActivityCursorSecretError();
  }
}
