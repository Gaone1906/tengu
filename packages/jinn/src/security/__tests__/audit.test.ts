import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE anything imports shared/paths.js
// (SESSIONS_DB is resolved from JINN_HOME at module load) — see
// work-items/__tests__/comments.test.ts for the same pattern.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-security-audit-"));
process.env.JINN_HOME = tmp;

type AuditMod = typeof import("../audit.js");
type StoreMod = typeof import("../../work-items/store.js");
type CommentsMod = typeof import("../../work-items/comments.js");
type RegistryMod = typeof import("../../sessions/registry.js");

let audit: AuditMod;
let store: StoreMod;
let comments: CommentsMod;
let registry: RegistryMod;

beforeAll(async () => {
  audit = await import("../audit.js");
  store = await import("../../work-items/store.js");
  comments = await import("../../work-items/comments.js");
  registry = await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).initDb();
});

describe("recordSecurityBlock", () => {
  it("writes an attributed work-item comment from the security employee when the session is linked to a Todo", () => {
    const item = store.createWorkItem({ title: "audited item" });
    const session = registry.createSession({ engine: "claude", source: "test", sourceRef: "audit-sess-1" });
    store.linkSession(item.id, session.id);

    audit.recordSecurityBlock({
      jinnSessionId: session.id,
      toolName: "Bash",
      reason: "Refusing git reset --hard",
      cwd: "/some/workspace",
    });

    const tail = comments.commentsTail(item.id, 10);
    expect(tail.comments).toHaveLength(1);
    expect(tail.comments[0]).toMatchObject({
      author: audit.SECURITY_EMPLOYEE_NAME,
      authorKind: "system",
    });
    expect(tail.comments[0].body).toMatch(/Bash blocked/);
    expect(tail.comments[0].body).toMatch(/Refusing git reset --hard/);
  });

  it("never throws when the session has no linked work item — falls back to a log line", () => {
    const session = registry.createSession({ engine: "claude", source: "test", sourceRef: "audit-sess-unlinked" });

    expect(() =>
      audit.recordSecurityBlock({
        jinnSessionId: session.id,
        toolName: "Write",
        reason: "Refusing write outside workspace",
      }),
    ).not.toThrow();
  });

  it("never throws when the session id is unknown to the registry", () => {
    expect(() =>
      audit.recordSecurityBlock({
        jinnSessionId: "no-such-session",
        toolName: "Edit",
        reason: "Refusing write outside workspace",
      }),
    ).not.toThrow();
  });
});
