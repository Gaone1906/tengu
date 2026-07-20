import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types.js";
import { buildDelegatedActivityIndex } from "../delegated-activity.js";

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    engine: "codex",
    engineSessionId: null,
    source: "web",
    sourceRef: `web:${id}`,
    connector: "web",
    sessionKey: `web:${id}`,
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    lastActivity: "2026-07-20T10:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

describe("buildDelegatedActivityIndex", () => {
  it("marks the direct parent of an active employee session", () => {
    const sessions = [
      session("parent"),
      session("child", { parentSessionId: "parent", employee: "platform-lead" }),
    ];

    expect(buildDelegatedActivityIndex(sessions, new Set(["child"]))).toEqual(new Map([
      ["parent", { activeSessions: 1, employees: ["platform-lead"] }],
    ]));
  });

  it("propagates transitive activity to every ancestor", () => {
    const sessions = [
      session("root"),
      session("manager", { parentSessionId: "root", employee: "ops-lead" }),
      session("worker", { parentSessionId: "manager", employee: "researcher" }),
    ];

    const index = buildDelegatedActivityIndex(sessions, new Set(["worker"]));

    expect(index.get("manager")).toEqual({ activeSessions: 1, employees: ["researcher"] });
    expect(index.get("root")).toEqual({ activeSessions: 1, employees: ["researcher"] });
    expect(index.has("worker")).toBe(false);
  });

  it("counts parallel sessions while de-duplicating employee identities", () => {
    const sessions = [
      session("parent"),
      session("first", { parentSessionId: "parent", employee: "researcher" }),
      session("second", { parentSessionId: "parent", employee: "researcher" }),
      session("third", { parentSessionId: "parent", employee: "writer" }),
    ];

    expect(buildDelegatedActivityIndex(sessions, new Set(["first", "second", "third"])).get("parent")).toEqual({
      activeSessions: 3,
      employees: ["researcher", "writer"],
    });
  });

  it("ignores inactive descendants and safely stops at graph cycles", () => {
    const sessions = [
      session("idle-parent"),
      session("idle-child", { parentSessionId: "idle-parent", employee: "writer" }),
      session("cycle-a", { parentSessionId: "cycle-b", employee: "one" }),
      session("cycle-b", { parentSessionId: "cycle-a", employee: "two" }),
    ];

    const index = buildDelegatedActivityIndex(sessions, new Set(["cycle-a"]));

    expect(index.has("idle-parent")).toBe(false);
    expect(index.get("cycle-b")).toEqual({ activeSessions: 1, employees: ["one"] });
    expect(index.has("cycle-a")).toBe(false);
  });
});
