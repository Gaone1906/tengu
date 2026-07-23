import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { derivePrefixCandidate, pickFreePrefix, resolveDepartmentPrefix } from "../departments.js";
import { allocateWorkItemId, migrateWorkItemsSchema, registerWorkItemIdentityFunctions } from "../migrate.js";

describe("derivePrefixCandidate", () => {
  it("uses the standard company derivation when the slug supports it", () => {
    expect(derivePrefixCandidate("platform")).toBe("PLA");
    expect(derivePrefixCandidate("customer-success-team")).toBe("CST");
  });
  it("pads short slugs with X instead of throwing", () => {
    expect(derivePrefixCandidate("hr")).toBe("HRX");
    expect(derivePrefixCandidate("q")).toBe("QXX");
  });
  it("falls back to XXX when the slug has no letters", () => {
    expect(derivePrefixCandidate("123")).toBe("XXX");
  });
});

describe("pickFreePrefix", () => {
  it("returns the candidate when free", () => {
    expect(pickFreePrefix("PLA", new Set(["ACM"]))).toBe("PLA");
  });
  it("advances the third letter deterministically on collision", () => {
    expect(pickFreePrefix("PLA", new Set(["PLA"]))).toBe("PLB");
    expect(pickFreePrefix("PLA", new Set(["PLA", "PLB"]))).toBe("PLC");
  });
  it("wraps position 3 through A and moves to position 2 when exhausted", () => {
    const taken = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => `PL${c}`));
    expect(pickFreePrefix("PLA", taken)).toBe("PAA");
  });
});

describe("resolveDepartmentPrefix reservation", () => {
  it("never assigns a prefix already used as an allocator namespace (e.g. a retired company prefix)", () => {
    const db = new Database(":memory:");
    registerWorkItemIdentityFunctions(db);
    migrateWorkItemsSchema(db, "absent");
    // Historical company namespace: ICI has allocated ids but is no longer the
    // configured company prefix (which is now JNN).
    allocateWorkItemId(db, "2026-07-01T00:00:00.000Z", "ICI");
    const prefix = resolveDepartmentPrefix(db, "icing", "JNN");
    expect(prefix).not.toBe("ICI");
    expect(prefix).toBe("ICA"); // deterministic fallback: third letter restarts at A
    db.close();
  });

  it("rethrows a non-constraint insert failure instead of recursing", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-dept-ro-")), "reg.db");
    const rw = new Database(file);
    registerWorkItemIdentityFunctions(rw);
    migrateWorkItemsSchema(rw, "absent");
    rw.close();
    // Read-only connection: the lookup SELECTs work, but the registration INSERT
    // fails with a non-constraint error — that must surface, not loop forever.
    const ro = new Database(file, { readonly: true });
    expect(() => resolveDepartmentPrefix(ro, "platform", "JIN")).toThrow(/readonly/i);
    ro.close();
  });
});
