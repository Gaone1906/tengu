import { searchSessionsFiltered } from "../sessions/registry.js";
import {
  notifyManagerVisibility,
  type ManagerVisibilityDetails,
} from "../sessions/callbacks.js";
import { logger } from "../shared/logger.js";
import type { Employee, Session } from "../shared/types.js";
import { appendWorkItemEvent } from "../work-items/store.js";
import { resolveOrgHierarchy } from "./org-hierarchy.js";

export interface ManagerVisibilityInput {
  roster: Map<string, Employee>;
  employee: string;
  delegatorSession?: Session;
  childSession: Session;
  workItemId: string;
  title: string;
}

export interface ManagerVisibilityFallback {
  workItemId: string;
  manager: string;
  delegator: string | null;
  employee: string;
  childSessionId: string;
  title: string;
}

export interface ManagerVisibilityDeps {
  findManagerSession(manager: string): Session | undefined;
  notifyManager(managerSessionId: string, details: ManagerVisibilityDetails): void;
  appendFallback(fallback: ManagerVisibilityFallback): void;
  warn(message: string): void;
}

const defaultDeps: ManagerVisibilityDeps = {
  findManagerSession: (manager) =>
    searchSessionsFiltered({ employee: manager }, 20).find((session) => session.status !== "error"),
  notifyManager: notifyManagerVisibility,
  appendFallback: (fallback) => {
    appendWorkItemEvent({
      workItemId: fallback.workItemId,
      kind: "note",
      actor: "delegation",
      detail: {
        managerVisibility: {
          manager: fallback.manager,
          delegator: fallback.delegator,
          employee: fallback.employee,
          childSessionId: fallback.childSessionId,
          title: fallback.title,
        },
      },
    });
  },
  warn: (message) => logger.warn(message),
};

/**
 * Surface one skip-level delegation to the target employee's manager without
 * changing the route. Direct-report and same-manager work needs no extra signal.
 * Delivery is deliberately fail-open: visibility must never gate IC dispatch.
 */
export function surfaceManagerVisibility(
  input: ManagerVisibilityInput,
  deps: ManagerVisibilityDeps = defaultDeps,
): void {
  try {
    const hierarchy = resolveOrgHierarchy(input.roster);
    const targetNode = hierarchy.nodes[input.employee];
    const manager = targetNode?.parentName;
    if (!manager) return;

    const delegator = input.delegatorSession?.employee ?? null;
    const delegatorManager = delegator ? hierarchy.nodes[delegator]?.parentName ?? null : null;
    if (delegator === manager || delegatorManager === manager) return;

    const managerEmployee = input.roster.get(manager);
    const targetEmployee = targetNode.employee;
    const delegatorEmployee = delegator ? input.roster.get(delegator) : undefined;
    const details: ManagerVisibilityDetails = {
      manager,
      managerDisplay: managerEmployee?.displayName || manager,
      delegator,
      delegatorDisplay: delegatorEmployee?.displayName || delegator || "The operator",
      employee: input.employee,
      employeeDisplay: targetEmployee.displayName || input.employee,
      childSessionId: input.childSession.id,
      workItemId: input.workItemId,
      title: input.title,
    };

    const managerSession = deps.findManagerSession(manager);
    if (managerSession) {
      deps.notifyManager(managerSession.id, details);
      return;
    }

    deps.appendFallback({
      workItemId: input.workItemId,
      manager,
      delegator,
      employee: input.employee,
      childSessionId: input.childSession.id,
      title: input.title,
    });
  } catch (error) {
    deps.warn(`Manager visibility failed open: ${error instanceof Error ? error.message : String(error)}`);
  }
}
