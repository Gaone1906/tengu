import { describe, it, expect, beforeAll, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the session/work-item DB at a throwaway dir BEFORE anything imports
// shared/paths.js (SESSIONS_DB is resolved from JINN_HOME at module load) —
// mirrors work-items/__tests__/comments.test.ts. Every module reachable from
// hook-endpoint.js that touches the DB is imported dynamically in beforeAll,
// after this line runs, never via a top-level static import.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-hook-write-policy-"));
process.env.JINN_HOME = tmp;

type HookEndpointMod = typeof import("../hook-endpoint.js");
type HookRegistryMod = typeof import("../hook-registry.js");
type StoreMod = typeof import("../../work-items/store.js");
type CommentsMod = typeof import("../../work-items/comments.js");
type RegistryMod = typeof import("../../sessions/registry.js");

let hookEndpoint: HookEndpointMod;
let HookRegistry: HookRegistryMod["HookRegistry"];
let store: StoreMod;
let comments: CommentsMod;
let registry: RegistryMod;

beforeAll(async () => {
  hookEndpoint = await import("../hook-endpoint.js");
  ({ HookRegistry } = await import("../hook-registry.js"));
  store = await import("../../work-items/store.js");
  comments = await import("../../work-items/comments.js");
  registry = await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).initDb();
});

describe("PreToolUse policy for Write/Edit/NotebookEdit", () => {
  const registries: InstanceType<HookRegistryMod["HookRegistry"]>[] = [];
  const workspaces: string[] = [];

  afterEach(() => {
    while (registries.length > 0) registries.pop()!.dispose();
    while (workspaces.length > 0) fs.rmSync(workspaces.pop()!, { recursive: true, force: true });
  });

  function makeReg() {
    const r = new HookRegistry();
    registries.push(r);
    return r;
  }

  function workspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-hook-write-ws-"));
    workspaces.push(root);
    return root;
  }

  let sessionCounter = 0;
  function freshSessionId(): string {
    sessionCounter += 1;
    return `hook-write-policy-sess-${sessionCounter}`;
  }

  it("allows a legitimate in-cwd Write and delivers the hook", () => {
    const cwd = workspace();
    const reg = makeReg();
    const sessionId = freshSessionId();
    const seen: string[] = [];
    reg.register(sessionId, (h) => seen.push(h.hook_event_name));

    const res = hookEndpoint.handleHookPost(
      { reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek",
      {
        jinnSessionId: sessionId,
        hook: {
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          cwd,
          tool_input: { file_path: "notes.md", content: "hi" },
        },
      },
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual(["PreToolUse"]);
  });

  it("blocks a path-escape Write (e.g. ../outside-cwd/file) with 451 and never delivers it", () => {
    const cwd = workspace();
    const reg = makeReg();
    const sessionId = freshSessionId();
    const seen: string[] = [];
    reg.register(sessionId, (h) => seen.push(h.hook_event_name));

    const res = hookEndpoint.handleHookPost(
      { reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek",
      {
        jinnSessionId: sessionId,
        hook: {
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          cwd,
          tool_input: { file_path: "../outside-cwd/file.txt", content: "x" },
        },
      },
    );

    expect(res.status).toBe(451);
    expect(res.body).toMatch(/escapes/);
    expect(seen).toEqual([]);
  });

  it("blocks an escaping Edit and a NotebookEdit the same way", () => {
    const cwd = workspace();
    const reg = makeReg();

    const editSessionId = freshSessionId();
    const editRes = hookEndpoint.handleHookPost(
      { reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek",
      {
        jinnSessionId: editSessionId,
        hook: {
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          cwd,
          tool_input: { file_path: "/etc/passwd", old_string: "a", new_string: "b" },
        },
      },
    );
    expect(editRes.status).toBe(451);

    const notebookSessionId = freshSessionId();
    const notebookRes = hookEndpoint.handleHookPost(
      { reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek",
      {
        jinnSessionId: notebookSessionId,
        hook: {
          hook_event_name: "PreToolUse",
          tool_name: "NotebookEdit",
          cwd,
          tool_input: { notebook_path: "../outside.ipynb", new_source: "print(1)" },
        },
      },
    );
    expect(notebookRes.status).toBe(451);
  });

  it("attributes a blocked Write as a work-item comment from the security employee", () => {
    const cwd = workspace();
    const item = store.createWorkItem({ title: "confined write target" });
    const sessionId = freshSessionId();
    const session = registry.createSession({
      engine: "claude",
      source: "test",
      sourceRef: sessionId,
    });
    store.linkSession(item.id, session.id);

    const reg = makeReg();
    const res = hookEndpoint.handleHookPost(
      { reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek",
      {
        jinnSessionId: session.id,
        hook: {
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          cwd,
          tool_input: { file_path: "../outside-cwd/file.txt", content: "x" },
        },
      },
    );
    expect(res.status).toBe(451);

    const tail = comments.commentsTail(item.id, 10);
    const receipt = tail.comments.find((c) => c.author === "security");
    expect(receipt).toBeDefined();
    expect(receipt?.authorKind).toBe("system");
    expect(receipt?.body).toMatch(/Write blocked/);
    expect(receipt?.body).toMatch(/escapes/);
  });
});
