import { describe, expect, it, vi } from "vitest";
import type { Employee, Session } from "../../shared/types.js";
import { surfaceManagerVisibility, type ManagerVisibilityDeps } from "../manager-visibility.js";

function employee(
  name: string,
  rank: Employee["rank"],
  reportsTo?: string,
): Employee {
  return {
    name,
    displayName: name
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    department: name === "org-root" ? "operations" : "platform",
    rank,
    engine: "codex",
    model: "test-model",
    persona: `${name} test persona`,
    reportsTo,
  };
}

const roster = new Map<string, Employee>([
  ["org-root", employee("org-root", "executive")],
  ["team-lead", employee("team-lead", "manager", "org-root")],
  ["worker", employee("worker", "employee", "team-lead")],
  ["peer", employee("peer", "senior", "team-lead")],
]);

function session(id: string, owner: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    engine: "codex",
    engineSessionId: null,
    source: "web",
    sourceRef: `web:${id}`,
    employee: owner,
    status: "idle",
    connector: "web",
    createdAt: "2026-07-10T00:00:00.000Z",
    lastActivity: "2026-07-10T00:00:00.000Z",
    ...overrides,
  } as Session;
}

function deps(managerSession: Session | null = session("manager-session", "team-lead", { status: "running" })) {
  return {
    findManagerSession: vi.fn(() => managerSession ?? undefined),
    notifyManager: vi.fn(),
    appendFallback: vi.fn(),
    warn: vi.fn(),
  } satisfies ManagerVisibilityDeps;
}

function input(delegator: string) {
  return {
    roster,
    employee: "worker",
    delegatorSession: session(`${delegator}-session`, delegator),
    childSession: session("worker-child", "worker"),
    workItemId: "wi_manager_visibility",
    title: "Inspect a bounded incident",
  };
}

describe("surfaceManagerVisibility", () => {
  it("notifies the target manager exactly once for a skip-level delegation", () => {
    const d = deps();

    surfaceManagerVisibility(input("org-root"), d);

    expect(d.findManagerSession).toHaveBeenCalledOnce();
    expect(d.findManagerSession).toHaveBeenCalledWith("team-lead");
    expect(d.notifyManager).toHaveBeenCalledOnce();
    expect(d.notifyManager).toHaveBeenCalledWith(
      "manager-session",
      expect.objectContaining({
        manager: "team-lead",
        delegator: "org-root",
        employee: "worker",
        childSessionId: "worker-child",
        workItemId: "wi_manager_visibility",
      }),
    );
    expect(d.appendFallback).not.toHaveBeenCalled();
  });

  it("does not emit the extra signal for a direct-report delegation", () => {
    const d = deps();

    surfaceManagerVisibility(input("team-lead"), d);

    expect(d.findManagerSession).not.toHaveBeenCalled();
    expect(d.notifyManager).not.toHaveBeenCalled();
    expect(d.appendFallback).not.toHaveBeenCalled();
  });

  it("does not emit the extra signal when delegator and target share a manager", () => {
    const d = deps();

    surfaceManagerVisibility(input("peer"), d);

    expect(d.findManagerSession).not.toHaveBeenCalled();
    expect(d.notifyManager).not.toHaveBeenCalled();
    expect(d.appendFallback).not.toHaveBeenCalled();
  });

  it("links one fallback reference on the Todo when the manager has no session", () => {
    const d = deps(null);

    surfaceManagerVisibility(input("org-root"), d);

    expect(d.notifyManager).not.toHaveBeenCalled();
    expect(d.appendFallback).toHaveBeenCalledOnce();
    expect(d.appendFallback).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: "wi_manager_visibility",
      manager: "team-lead",
      employee: "worker",
      childSessionId: "worker-child",
    }));
  });

  it.each([
    ["completed", session("completed-manager", "team-lead", { status: "idle", attemptOutcome: "succeeded" })],
    ["stopped", session("stopped-manager", "team-lead", { status: "interrupted", attemptOutcome: "interrupted" })],
    ["stale", session("stale-manager", "team-lead", { status: "idle", attemptOutcome: null })],
  ])("records the Todo fallback instead of waking a %s manager session", (_label, managerSession) => {
    const d = deps(managerSession);

    surfaceManagerVisibility(input("org-root"), d);

    expect(d.notifyManager).not.toHaveBeenCalled();
    expect(d.appendFallback).toHaveBeenCalledOnce();
    expect(d.appendFallback).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: "wi_manager_visibility",
      manager: "team-lead",
      childSessionId: "worker-child",
    }));
  });

  it.each(["running", "waiting"] as const)("still notifies an active %s manager session", (status) => {
    const d = deps(session(`${status}-manager`, "team-lead", { status }));

    surfaceManagerVisibility(input("org-root"), d);

    expect(d.notifyManager).toHaveBeenCalledOnce();
    expect(d.appendFallback).not.toHaveBeenCalled();
  });

  it("does not treat a historical Workflow run projection as an active manager conversation", () => {
    const managerSession = session("legacy-run", "team-lead", {
      status: "running",
      engine: "workflow",
      workflowProvenance: {
        kind: "run",
        workflowId: "release-review",
        workflowName: "release-review",
        runId: "run-old",
        triggerSource: "manual",
      },
    });
    const d = deps(managerSession);

    surfaceManagerVisibility(input("org-root"), d);

    expect(d.notifyManager).not.toHaveBeenCalled();
    expect(d.appendFallback).toHaveBeenCalledOnce();
  });

  it("fails open when visibility delivery throws", () => {
    const d = deps();
    d.notifyManager.mockImplementation(() => {
      throw new Error("visibility transport unavailable");
    });

    expect(() => surfaceManagerVisibility(input("org-root"), d)).not.toThrow();
    expect(d.warn).toHaveBeenCalledOnce();
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining("visibility transport unavailable"));
  });
});
