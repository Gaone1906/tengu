import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

// Isolate the DB: JINN_HOME must be set before importing registry (SESSIONS_DB
// is resolved at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-engine-sessions-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");

describe("engine session refs", () => {
  beforeEach(() => {
    const db = reg.initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("migrates legacy session tables with a dedicated engine_sessions column", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        engine_session_id TEXT,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        employee TEXT,
        model TEXT,
        status TEXT DEFAULT 'idle',
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        last_error TEXT
      )
    `);

    reg.migrateSessionsSchema(db);

    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("engine_sessions");
  });

  it("records native ids per engine without letting inactive engines replace the active id", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:engine-refs",
      model: "opus",
      effortLevel: "high",
    });

    const claude = reg.recordEngineSessionId(s.id, "claude", "claude-native-1", {
      model: "opus",
      effortLevel: "high",
      lastSyncedAt: "2026-07-07T08:00:00.000Z",
    });
    expect(claude?.engineSessionId).toBe("claude-native-1");
    expect(reg.getEngineSessionRef(claude!, "claude")).toEqual({
      id: "claude-native-1",
      model: "opus",
      effortLevel: "high",
      lastSyncedAt: "2026-07-07T08:00:00.000Z",
    });

    const codex = reg.recordEngineSessionId(s.id, "codex", "codex-native-1", {
      model: "gpt-5.5",
      effortLevel: "medium",
    });
    expect(codex?.engineSessionId).toBe("claude-native-1");
    expect(reg.getEngineSessionRef(codex!, "codex")).toEqual({
      id: "codex-native-1",
      model: "gpt-5.5",
      effortLevel: "medium",
    });
  });

  it("switches active engines by restoring saved native ids instead of creating a new ref", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:switch",
      model: "opus",
      effortLevel: "high",
    });
    reg.recordEngineSessionId(s.id, "claude", "claude-native-1", {
      model: "opus",
      effortLevel: "high",
      lastSyncedAt: "2026-07-07T08:00:00.000Z",
    });

    const switchedToCodex = reg.switchSessionEngine(s.id, "codex", {
      model: "gpt-5.5",
      effortLevel: "medium",
    });
    expect(switchedToCodex?.engine).toBe("codex");
    expect(switchedToCodex?.engineSessionId).toBeNull();
    expect(switchedToCodex?.model).toBe("gpt-5.5");
    expect(switchedToCodex?.effortLevel).toBe("medium");
    expect(switchedToCodex?.transportMeta?.engineSyncTarget).toBe("codex");
    expect(switchedToCodex?.transportMeta?.engineSyncSince).toBe(s.createdAt);

    reg.recordEngineSessionId(s.id, "codex", "codex-native-1", {
      model: "gpt-5.5",
      effortLevel: "medium",
      lastSyncedAt: "2026-07-07T08:05:00.000Z",
    });

    const switchedBack = reg.switchSessionEngine(s.id, "claude", {
      model: "opus",
      effortLevel: "high",
    });
    expect(switchedBack?.engine).toBe("claude");
    expect(switchedBack?.engineSessionId).toBe("claude-native-1");
    expect(switchedBack?.model).toBe("opus");
    expect(switchedBack?.effortLevel).toBe("high");
    expect(switchedBack?.transportMeta?.engineSyncTarget).toBe("claude");
    expect(switchedBack?.transportMeta?.engineSyncSince).toBe("2026-07-07T08:00:00.000Z");
  });

  it("preserves a legacy active engine_session_id when switching away", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:legacy-switch",
      model: "opus",
      effortLevel: "high",
    });
    reg.updateSession(s.id, { engineSessionId: "legacy-claude-native" });

    const switched = reg.switchSessionEngine(s.id, "codex", {
      model: "gpt-5.5",
      effortLevel: "medium",
    });

    expect(reg.getEngineSessionRef(switched!, "claude").id).toBe("legacy-claude-native");
    expect(switched?.engineSessionId).toBeNull();
  });

  it("does not resume a saved Grok native session when switching back with a different Grok model", () => {
    const s = reg.createSession({
      engine: "grok",
      source: "web",
      sourceRef: "web:grok-model-bound",
      model: "grok-build",
      effortLevel: "high",
    });
    reg.recordEngineSessionId(s.id, "grok", "grok-native-1", {
      model: "grok-build",
      effortLevel: "high",
      lastSyncedAt: "2026-07-07T08:00:00.000Z",
    });

    const switchedToCodex = reg.switchSessionEngine(s.id, "codex", {
      model: "gpt-5.5",
      effortLevel: "medium",
    });
    expect(switchedToCodex?.engineSessionId).toBeNull();

    const switchedBack = reg.switchSessionEngine(s.id, "grok", {
      model: "grok-composer-2.5-fast",
      effortLevel: "medium",
    });

    expect(switchedBack?.engine).toBe("grok");
    expect(switchedBack?.engineSessionId).toBeNull();
    expect(switchedBack?.model).toBe("grok-composer-2.5-fast");
    expect(reg.getEngineSessionRef(switchedBack!, "grok")).toEqual({
      model: "grok-composer-2.5-fast",
      effortLevel: "medium",
    });
    expect(switchedBack?.transportMeta?.engineSyncSince).toBe(s.createdAt);
  });
});
