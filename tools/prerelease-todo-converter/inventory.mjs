import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../packages/jinn/package.json", import.meta.url));
const Database = require("better-sqlite3");

const LEGACY_TODO_ID = /^wi_[0-9a-f]{12}$/;
const LEGACY_TODO_TOKEN = /wi_[0-9a-f]{12}/g;
const TODO_PREFIX = /^[A-Z]{3}$/;
const TODO_KEYS = new Set(["todoId", "workItemId", "work_item_id"]);
const PROSE_KEYS = new Set(["title", "body", "content", "prompt", "summary", "note", "notes", "label", "error", "lastError"]);
const PROSE_FIELDS = new Set([
  "work_items.title", "work_items.body", "sessions.title", "sessions.prompt_excerpt", "sessions.last_error",
  "messages.content", "queue_items.prompt", "activity_events.summary", "activity_stories.summary",
  "activity_event_search.body", "activity_event_search.search_text",
]);
const ACTIVITY_PROSE_FIELDS = new Set(["actor_display_name", "object_label", "outcome_label", "summary", "search_text"]);
const EXPECTED_ACTIVITY_COLUMNS = new Map([
  ["activity_events", [
    "seq", "id", "story_id", "occurred_at", "kind", "action", "actor_type", "actor_id", "actor_display_name",
    "object_type", "object_id", "object_label", "object_href", "outcome_state", "outcome_label", "summary",
    "correlation_id", "causation_id", "root_event_id", "attempt", "idempotency_key", "detail_ref", "detail_json",
    "links_json", "payload_hash",
  ]],
  ["activity_stories", [
    "story_id", "latest_event_id", "latest_seq", "last_append_seq", "occurred_at", "event_count", "kind", "outcome_state",
  ]],
  ["activity_story_versions", [
    "story_id", "append_seq", "latest_event_id", "latest_seq", "occurred_at", "event_count", "kind", "outcome_state",
  ]],
  ["activity_event_search", ["event_id", "story_id", "seq", "search_text"]],
]);
const NEUTRAL_TECHNICAL_FIELDS = new Set([
  "sessions.id", "sessions.engine_session_id", "sessions.message_id", "sessions.parent_session_id",
  "sessions.workflow_id", "sessions.workflow_run_id", "sessions.reply_context", "messages.session_id",
  "messages.tool_call", "messages.tool_id", "queue_items.session_id", "callback_deliveries.id",
  "callback_deliveries.target_session_id", "callback_deliveries.source_id", "callback_deliveries.source_attempt",
  "callback_deliveries.source_outcome", "callback_deliveries.delivery_kind", "files.id",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all().map((column) => column.name);
}

function rowsWithLocator(db, table) {
  const escaped = table.replaceAll('"', '""');
  try {
    return db.prepare(`SELECT rowid AS __rowid, * FROM "${escaped}" ORDER BY rowid`).all();
  } catch {
    return db.prepare(`SELECT * FROM "${escaped}"`).all().map((row, index) => ({ __rowid: index + 1, ...row }));
  }
}

export function buildTodoMapping(db, prefix = "JIN") {
  if (!TODO_PREFIX.test(prefix)) throw new Error("Todo prefix must be exactly three uppercase Latin letters");
  if (!tableExists(db, "work_items")) throw new Error("prerelease Todo table is missing");
  const names = new Set(columns(db, "work_items"));
  if (!names.has("id") || !names.has("created_at")) throw new Error("unknown prerelease work_items schema");
  const rows = db.prepare("SELECT id, created_at FROM work_items ORDER BY created_at COLLATE BINARY, id COLLATE BINARY").all();
  const mapping = new Map();
  for (const [index, row] of rows.entries()) {
    if (typeof row.id !== "string" || !LEGACY_TODO_ID.test(row.id) || typeof row.created_at !== "string") {
      throw new Error("mixed or malformed prerelease Todo identity");
    }
    mapping.set(row.id, `${prefix}-${index + 1}`);
  }
  return mapping;
}

function parseJson(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function legacyTokens(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.match(LEGACY_TODO_TOKEN) ?? [])];
}

function inventoryOpenDatabase(db, prefix) {
  const mapping = buildTodoMapping(db, prefix);
  const blockers = [];
  const locationCounts = new Map();
  const handledFields = new Set(["work_items.id"]);

  const addBlocker = (code, table, row, fieldPath, value) => {
    blockers.push({
      code,
      locator: `${table}:rowid:${row}`,
      fieldPath,
      valueDigest: sha256(String(value)),
    });
  };
  const countLocation = (table, fieldPath) => {
    const key = `${table}.${fieldPath}`;
    locationCounts.set(key, (locationCounts.get(key) ?? 0) + 1);
  };
  const recordToken = (token, table, row, fieldPath, code = "orphan-todo-reference") => {
    if (code === "activity-todo-reference") addBlocker(code, table, row, fieldPath, token);
    else if (!mapping.has(token)) addBlocker(code, table, row, fieldPath, token);
    else countLocation(table, fieldPath);
  };
  const recordStructuralString = (value, table, row, fieldPath, code) => {
    for (const token of legacyTokens(value)) recordToken(token, table, row, fieldPath, code);
  };
  const walkJson = (value, table, row, fieldPath, activity = false, parentKey = "") => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walkJson(entry, table, row, `${fieldPath}[${index}]`, activity, parentKey));
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && (TODO_KEYS.has(parentKey) || parentKey === "href"
        || (!PROSE_KEYS.has(parentKey) && /(?:^|_)(?:id|ref)$/i.test(parentKey)))) {
        recordStructuralString(value, table, row, fieldPath, activity ? "activity-todo-reference" : undefined);
      }
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      walkJson(entry, table, row, `${fieldPath}.${key}`, activity, key);
    }
  };

  const presentActivityTables = [...EXPECTED_ACTIVITY_COLUMNS.keys()].filter((table) => tableExists(db, table));
  if (presentActivityTables.length !== 0 && presentActivityTables.length !== EXPECTED_ACTIVITY_COLUMNS.size) {
    addBlocker("activity-schema-mismatch", "activity", 0, "tables", stableJson(presentActivityTables));
  }
  for (const [table, expected] of EXPECTED_ACTIVITY_COLUMNS) {
    if (!tableExists(db, table)) continue;
    const actual = columns(db, table);
    if (stableJson(actual) !== stableJson(expected)) {
      addBlocker("activity-schema-mismatch", table, 0, "columns", stableJson(actual));
    }
  }

  const scanDirect = (table, field, mode = "exact") => {
    if (!tableExists(db, table) || !columns(db, table).includes(field)) return;
    handledFields.add(`${table}.${field}`);
    for (const row of rowsWithLocator(db, table)) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      if (mode === "exact") {
        if (typeof value === "string" && LEGACY_TODO_ID.test(value)) recordToken(value, table, row.__rowid, field);
        else if (legacyTokens(value).length > 0) addBlocker("malformed-structured-todo-reference", table, row.__rowid, field, value);
      } else if (mode === "structural") {
        recordStructuralString(value, table, row.__rowid, field);
      } else if (mode === "json") {
        const parsed = parseJson(value);
        if (parsed !== null) walkJson(parsed, table, row.__rowid, field);
        else if (legacyTokens(value).length > 0) addBlocker("malformed-structured-json", table, row.__rowid, field, value);
      }
    }
  };

  scanDirect("work_item_events", "work_item_id");
  scanDirect("work_item_events", "detail", "json");
  scanDirect("sessions", "work_item_id");
  scanDirect("sessions", "source_ref", "structural");
  scanDirect("sessions", "transport_meta", "json");
  scanDirect("messages", "id", "structural");
  scanDirect("messages", "meta", "json");
  scanDirect("messages", "blocks", "json");
  scanDirect("messages", "media", "json");
  scanDirect("messages", "source_ref", "structural");
  scanDirect("callback_deliveries", "payload", "json");
  scanDirect("callback_deliveries", "message_id", "structural");
  scanDirect("callback_deliveries", "queue_item_id", "structural");
  scanDirect("queue_items", "id", "structural");
  scanDirect("queue_items", "session_key", "structural");

  if (tableExists(db, "callback_deliveries")) {
    const callbackColumns = new Set(columns(db, "callback_deliveries"));
    const messageIds = tableExists(db, "messages")
      ? new Set(rowsWithLocator(db, "messages").map((row) => row.id))
      : new Set();
    const queueIds = tableExists(db, "queue_items")
      ? new Set(rowsWithLocator(db, "queue_items").map((row) => row.id))
      : new Set();
    for (const row of rowsWithLocator(db, "callback_deliveries")) {
      if (callbackColumns.has("status") && row.status !== "accepted") continue;
      const payloadTokens = legacyTokens(row.payload);
      if (payloadTokens.length === 0) continue;
      const projected = [row.message_id, row.queue_item_id];
      const allAbsent = projected.every((value) => value === null || value === undefined);
      const allPresent = projected.every((value) => typeof value === "string" && value.length > 0);
      if (!allAbsent && !allPresent) {
        addBlocker("partial-callback-projection", "callback_deliveries", row.__rowid, "accepted-projection", stableJson(projected));
        continue;
      }
      if (allPresent && (!messageIds.has(row.message_id) || !queueIds.has(row.queue_item_id))) {
        addBlocker("dangling-callback-projection", "callback_deliveries", row.__rowid, "accepted-projection", stableJson(projected));
      }
    }
  }

  for (const table of ["activity_events", "activity_stories", "activity_story_versions", "activity_event_search"]) {
    if (!tableExists(db, table)) continue;
    for (const row of rowsWithLocator(db, table)) {
      for (const [field, value] of Object.entries(row)) {
        if (field === "__rowid" || value === null || value === undefined) continue;
        if (field === "detail_json" || field === "links_json") {
          const parsed = parseJson(value);
          if (parsed === null) {
            addBlocker("activity-malformed-json", table, row.__rowid, field, value);
          } else {
            walkJson(parsed, table, row.__rowid, field, true);
          }
          continue;
        }
        if (!ACTIVITY_PROSE_FIELDS.has(field)) {
          recordStructuralString(value, table, row.__rowid, field, "activity-todo-reference");
        }
      }
    }
  }

  const userTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).pluck().all();
  for (const table of userTables) {
    for (const row of rowsWithLocator(db, table)) {
      for (const [field, value] of Object.entries(row)) {
        if (field === "__rowid" || legacyTokens(value).length === 0) continue;
        const location = `${table}.${field}`;
        if (handledFields.has(location) || PROSE_FIELDS.has(location) || NEUTRAL_TECHNICAL_FIELDS.has(location)) continue;
        if (table.startsWith("activity_")) continue;
        addBlocker("unclassified-todo-reference", table, row.__rowid, field, value);
      }
    }
  }

  blockers.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  const locations = [...locationCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([location, count]) => ({ location, count }));
  if (mapping.size > 0) locations.unshift({ location: "work_items.id", count: mapping.size });
  return { mapping, blockers, locations };
}

export function inventoryDatabaseForDryRun({ databasePath, prefix = "JIN" }) {
  let stat = null;
  try {
    stat = typeof databasePath === "string" && databasePath ? fs.lstatSync(databasePath) : null;
  } catch {
    // Keep path data out of diagnostics.
  }
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error("databasePath must name an existing regular non-symlink file");
  }
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const { mapping, blockers, locations } = inventoryOpenDatabase(db, prefix);
    const base = {
      schemaVersion: 1,
      ok: blockers.length === 0,
      todoCount: mapping.size,
      mappingDigest: sha256(stableJson([...mapping])),
      locations,
      blockers,
    };
    return {
      mapping,
      report: { ...base, reportDigest: sha256(stableJson(base)) },
    };
  } finally {
    db.close();
  }
}

export function inventoryDatabase(input) {
  return inventoryDatabaseForDryRun(input).report;
}
