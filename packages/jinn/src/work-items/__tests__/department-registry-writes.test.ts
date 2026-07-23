import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-dept-writes-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Departments = typeof import("../departments.js");
type Migrate = typeof import("../migrate.js");
let store: Store;
let transitions: Transitions;
let departments: Departments;
let migrate: Migrate;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  departments = await import("../departments.js");
  migrate = await import("../migrate.js");
  db = (await import("../../sessions/registry.js")).initDb();
});

function registeredSlugs(): string[] {
  return db.prepare("SELECT slug FROM departments ORDER BY slug").pluck().all() as string[];
}

/**
 * Review F2: every write that lands a non-null department must register it in
 * the departments table inside the same transaction, so /api/departments can
 * never omit a department that holds live Todos.
 */
describe("department registry on department-changing writes", () => {
  it("assignWorkItem registers a previously unseen department", () => {
    const item = store.createWorkItem({ title: "assign move" });
    transitions.assignWorkItem(item.id, "mover", "assign-only-dept", "operator");
    expect(registeredSlugs()).toContain("assign-only-dept");
    const listed = departments.listDepartmentsWithCounts(db).find((d) => d.slug === "assign-only-dept");
    expect(listed).toBeDefined();
    expect(listed!.todoCount).toBe(1);
  });

  it("updateWorkItemConditional registers a department set through the metadata pen", () => {
    const item = store.createWorkItem({ title: "conditional move" });
    const result = store.updateWorkItemConditional(item.id, { department: "edit-only-dept" }, { expectedVersion: item.version, actor: "operator" });
    expect(result?.item.department).toBe("edit-only-dept");
    expect(registeredSlugs()).toContain("edit-only-dept");
  });

  it("updateWorkItem (compatibility write) registers the department too", () => {
    const item = store.createWorkItem({ title: "compat move" });
    const updated = store.updateWorkItem(item.id, { department: "compat-only-dept" }, "operator");
    expect(updated?.department).toBe("compat-only-dept");
    expect(registeredSlugs()).toContain("compat-only-dept");
  });

  it("boot-time reconciliation registers legacy move-only departments (pre-fix rows)", () => {
    const item = store.createWorkItem({ title: "legacy move" });
    // Forge a pre-fix move: a non-null department written without registration
    // (what assignment/edit did before this fix).
    db.prepare("UPDATE work_items SET department = 'ghost-dept' WHERE id = ?").run(item.id);
    expect(registeredSlugs()).not.toContain("ghost-dept");

    const result = migrate.migrateWorkItemsSchema(db);
    expect(result.rebuilt).toBe(false);
    expect(registeredSlugs()).toContain("ghost-dept");
    const listed = departments.listDepartmentsWithCounts(db).find((d) => d.slug === "ghost-dept");
    expect(listed!.todoCount).toBe(1);
    // Idempotent: a second boot changes nothing.
    migrate.migrateWorkItemsSchema(db);
    expect(registeredSlugs().filter((slug) => slug === "ghost-dept")).toHaveLength(1);
  });

  it("clearing a department (null) registers nothing", () => {
    const item = store.createWorkItem({ title: "null move" });
    const before = registeredSlugs();
    transitions.assignWorkItem(item.id, "mover", null, "operator");
    expect(registeredSlugs()).toEqual(before);
  });
});
