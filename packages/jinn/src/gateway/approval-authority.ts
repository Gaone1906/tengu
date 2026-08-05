import type { IncomingHttpHeaders } from "node:http";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "../mcp/identity.js";
import { verifySessionCapability } from "../mcp/identity.js";
import { getSession, listSessionsByWorkItem } from "../sessions/registry.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { Employee, Session } from "../shared/types.js";
import type { WorkItem } from "../work-items/store.js";
import { isOrgAncestor, resolveOrgHierarchy } from "./org-hierarchy.js";
import { scanOrg } from "./org.js";
import { resolveCallerIdentity } from "./session-comm-guards.js";

export type ApprovalRootKind = "employee" | "virtual";

export interface RootApprovalTarget {
  name: string;
  department: string | null;
  kind: ApprovalRootKind;
}

export interface ApprovalRouteTarget {
  owner: string | null;
  target: string | null;
  root: string | null;
  rootKind: ApprovalRootKind | null;
  targetDepartment: string | null;
  targetIsVirtualRoot: boolean;
}

export interface ApprovalDecisionAuthority extends ApprovalRouteTarget {
  actor: string;
  kind: "employee" | "operator";
  employee?: string;
}

export type ApprovalAuthorityResult =
  | { ok: true; authority: ApprovalDecisionAuthority }
  | { ok: false; status: 403; error: string };

export interface ApprovalDecisionAuthorityOptions {
  /** Browser/operator console acts as the root/COO only on the Todo approval surface. */
  operatorCanActOnRootTarget?: boolean;
  /** Set only after gateway bearer/cookie verification at the HTTP boundary. */
  operatorAuthenticated?: boolean;
  /** Gate reserved for the human operator: no employee may decide it, not even
   *  the COO, and not via escalation. Resolved by the caller from the workflow
   *  node that parked the gate. */
  operatorOnly?: boolean;
}

function employeeDepartment(registry: Map<string, Employee>, employee: string | null): string | null {
  if (!employee) return null;
  return registry.get(employee)?.department ?? null;
}

const warnedPortalRootCollisions = new Set<string>();

function configuredPortalName(): string {
  try {
    const portalName = loadConfig().portal?.portalName?.trim();
    if (portalName) return portalName;
  } catch {
    // Tests and partially-seeded homes may not have a complete config yet.
  }
  return "Jinn";
}

function portalApprovalRoot(registry: Map<string, Employee>): RootApprovalTarget | null {
  const configuredName = configuredPortalName();
  if (!registry.has(configuredName)) return { name: configuredName, department: null, kind: "virtual" };

  if (!warnedPortalRootCollisions.has(configuredName)) {
    warnedPortalRootCollisions.add(configuredName);
    logger.warn(`portal.portalName "${configuredName}" collides with an org employee; ignoring it as approval root so employee authority cannot inherit virtual COO authority`);
  }

  for (const candidate of ["Jinn", "Portal COO", "operator", "COO"]) {
    if (candidate !== configuredName && !registry.has(candidate)) {
      return { name: candidate, department: null, kind: "virtual" };
    }
  }

  logger.warn("No collision-free virtual approval root name is available; COO-default approval routing is disabled until portal.portalName is distinct from org employees");
  return null;
}

function resolveRootApprovalTargetFrom(registry: Map<string, Employee>, hierarchyRoot: string | null): RootApprovalTarget | null {
  if (hierarchyRoot) return { name: hierarchyRoot, department: registry.get(hierarchyRoot)?.department ?? null, kind: "employee" };
  return portalApprovalRoot(registry);
}

function sourceSessionId(item: WorkItem): string | null {
  if (!item.sourceRef) return null;
  const sessionMatch = /^session:([^:]+):/.exec(item.sourceRef);
  if (sessionMatch) return sessionMatch[1];
  const delegateMatch = /^delegate:([^:]+):/.exec(item.sourceRef);
  if (delegateMatch) return delegateMatch[1];
  return null;
}

function firstKnownLinkedEmployee(item: WorkItem, registry: Map<string, Employee>): string | null {
  for (const session of listSessionsByWorkItem(item.id)) {
    if (session.employee && registry.has(session.employee)) return session.employee;
  }
  return null;
}

function sourceEmployee(item: WorkItem, registry: Map<string, Employee>): string | null {
  const id = sourceSessionId(item);
  if (!id) return null;
  const session = getSession(id);
  return session?.employee && registry.has(session.employee) ? session.employee : null;
}

export function resolveApprovalRouteTarget(item: WorkItem): ApprovalRouteTarget {
  const registry = scanOrg();
  const hierarchy = resolveOrgHierarchy(registry);
  const rootTarget = resolveRootApprovalTargetFrom(registry, hierarchy.root);
  const root = rootTarget?.name ?? null;
  const owner =
    item.assignee && registry.has(item.assignee)
      ? item.assignee
      : firstKnownLinkedEmployee(item, registry) ?? sourceEmployee(item, registry);

  if (item.approvalTargetKind === "none") {
    return {
      owner: owner ?? null,
      target: null,
      root,
      rootKind: rootTarget?.kind ?? null,
      targetDepartment: null,
      targetIsVirtualRoot: false,
    };
  }

  if (item.approvalTargetKind === "virtual") {
    const target = item.approvalTarget ?? null;
    return {
      owner: owner ?? null,
      target,
      root: target,
      rootKind: target ? "virtual" : null,
      targetDepartment: null,
      targetIsVirtualRoot: !!target,
    };
  }

  if (item.approvalTargetKind === "employee") {
    const target = item.approvalTarget ?? null;
    return {
      owner: owner ?? null,
      target,
      root,
      rootKind: rootTarget?.kind ?? null,
      targetDepartment: employeeDepartment(registry, target),
      targetIsVirtualRoot: false,
    };
  }

  if (item.approvalTarget) {
    return {
      owner: owner ?? null,
      target: item.approvalTarget,
      root: item.approvalTarget,
      rootKind: "virtual",
      targetDepartment: null,
      targetIsVirtualRoot: true,
    };
  }

  const derivedTarget = owner ? hierarchy.nodes[owner]?.parentName ?? root : root;
  const explicitTarget =
    item.approvalTarget && (registry.has(item.approvalTarget) || item.approvalTarget === root)
      ? item.approvalTarget
      : null;
  const target = explicitTarget ?? derivedTarget ?? null;
  const targetIsVirtualRoot = !!rootTarget && rootTarget.kind === "virtual" && target === rootTarget.name;
  return {
    owner: owner ?? null,
    target,
    root,
    rootKind: rootTarget?.kind ?? null,
    targetDepartment: targetIsVirtualRoot ? rootTarget.department : employeeDepartment(registry, target),
    targetIsVirtualRoot,
  };
}

export function resolveRootApprovalTarget(): RootApprovalTarget | null {
  const registry = scanOrg();
  const root = resolveOrgHierarchy(registry).root;
  return resolveRootApprovalTargetFrom(registry, root);
}

function callerSession(headers: IncomingHttpHeaders, operatorAuthenticated = false): { ok: true; session: Session } | { ok: false; error: string } | { ok: true; operator: true } {
  const identity = resolveCallerIdentity(headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated,
  });
  if (identity.kind === "unidentified-tool" || identity.kind === "unauthenticated") return { ok: false, error: UNIDENTIFIED_TOOL_CALL_ERROR };
  if (identity.kind === "operator") return { ok: true, operator: true };
  const session = getSession(identity.callerId);
  return session ? { ok: true, session } : { ok: false, error: UNIDENTIFIED_TOOL_CALL_ERROR };
}

export function resolveApprovalDecisionAuthority(
  headers: IncomingHttpHeaders,
  item: WorkItem,
  opts: ApprovalDecisionAuthorityOptions = {},
): ApprovalAuthorityResult {
  const route = resolveApprovalRouteTarget(item);
  const caller = callerSession(headers, opts.operatorAuthenticated);
  if (!caller.ok) return { ok: false, status: 403, error: caller.error };

  if ("operator" in caller) {
    if (opts.operatorOnly) return { ok: true, authority: { ...route, kind: "operator", actor: "operator" } };
    const routedToRoot = opts.operatorCanActOnRootTarget === true && !!route.root && route.target === route.root;
    if (!routedToRoot && !item.approvalEscalatedAt) {
      return {
        ok: false,
        status: 403,
        error: "operator/aCEO approval decisions require a root/COO-routed approval or an explicit escalation from the routed manager or COO first",
      };
    }
    return { ok: true, authority: { ...route, kind: "operator", actor: "operator" } };
  }

  // Ahead of every employee path, including the escalated-executive one: an
  // operator-only gate must not be reachable by escalating it to the COO.
  if (opts.operatorOnly) {
    return { ok: false, status: 403, error: `Todo ${item.id} has an operator-only approval; only the operator/aCEO may decide it` };
  }

  const employee = caller.session.employee;
  if (!employee) {
    return { ok: false, status: 403, error: `session ${caller.session.id} has no employee identity; approval decisions require manager/COO authority` };
  }
  const registry = scanOrg();
  const emp = registry.get(employee);
  if (!emp) {
    return { ok: false, status: 403, error: `employee "${employee}" is not in the org roster; approval decisions require manager/COO authority` };
  }
  if (route.owner && employee === route.owner && !(employee === route.root && route.rootKind === "employee")) {
    return { ok: false, status: 403, error: `employee "${employee}" owns Todo ${item.id} and cannot decide its own approval` };
  }
  if (route.target && employee === route.target && !route.targetIsVirtualRoot) {
    return { ok: true, authority: { ...route, kind: "employee", employee, actor: employee } };
  }
  if (emp.rank === "manager" || emp.rank === "executive") {
    const hierarchy = resolveOrgHierarchy(registry);
    if (route.owner && isOrgAncestor(hierarchy, employee, route.owner)) {
      return { ok: true, authority: { ...route, kind: "employee", employee, actor: employee } };
    }
  }
  if (route.root && route.rootKind === "employee" && employee === route.root) {
    return { ok: true, authority: { ...route, kind: "employee", employee, actor: employee } };
  }
  if (item.approvalEscalatedAt && emp.rank === "executive") {
    return { ok: true, authority: { ...route, kind: "employee", employee, actor: employee } };
  }
  return {
    ok: false,
    status: 403,
    error: `employee "${employee}" is not the routed approval target${route.target ? ` "${route.target}"` : ""} or COO for Todo ${item.id}`,
  };
}
