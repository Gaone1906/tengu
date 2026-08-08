import type { Employee, JinnConfig } from "../shared/types.js";

type SystemEmployeeDefinition = Omit<
  Employee,
  "engine" | "model" | "effortLevel" | "alwaysNotify"
>;

export const SYSTEM_EMPLOYEE_OVERRIDE_FIELDS = [
  "engine",
  "model",
  "effortLevel",
  "alwaysNotify",
] as const;

export const TODO_DISPATCHER_NAME = "todo-dispatcher";
export const SECURITY_EMPLOYEE_NAME = "security";

export const SYSTEM_EMPLOYEES: readonly SystemEmployeeDefinition[] = [
  {
    name: SECURITY_EMPLOYEE_NAME,
    displayName: "Security",
    department: "system",
    rank: "executive",
    persona: `You are Security, the system employee that owns Jinn's policy floor: the command/write deny-list, workspace confinement, and restore points.

You do not run sessions or receive delegated Todos. Every time a PreToolUse check blocks a Bash command or a Write/Edit/NotebookEdit call, that refusal is attributed to you — as a comment on the linked Todo when one exists, or a log line otherwise — so blocks are legible in the audit trail and the stand-up rather than a bare HTTP 451 nobody sees.`,
    emoji: "🛡️",
    jinnMcp: false,
    system: true,
  },
  {
    name: TODO_DISPATCHER_NAME,
    displayName: "Todo Dispatcher",
    department: "system",
    rank: "senior",
    persona: `You are the Todo Dispatcher, a system employee that starts tracked Todo work.

For the Todo named in your prompt:
1. Read it with get_work_item.
2. Inspect the roster with find_employees, then use get_employee for the best candidates.
3. Choose the employee whose role and experience best fit the complete Todo.
4. Call delegate_task with the existing workItemId, the chosen employee, and a self-contained brief that includes the acceptance criteria.
5. Comment on the Todo with the choice and the concrete reason for it, then end your turn.

Do not perform the Todo yourself. If no existing employee is a credible fit, explain the missing role in a Todo comment instead of guessing or creating untracked work.`,
    emoji: "🧭",
    jinnMcp: true,
    system: true,
  },
];

export function resolveSystemEmployees(config?: JinnConfig): Employee[] {
  const engine = config?.engines.default ?? "claude";
  const engineConfig = config?.engines[engine] as
    | { model?: string; effortLevel?: string }
    | undefined;
  const model = engineConfig?.model ?? (engine === "claude" ? "sonnet" : "default");

  return SYSTEM_EMPLOYEES.map((employee) => ({
    ...employee,
    engine,
    model,
    effortLevel: engineConfig?.effortLevel,
    alwaysNotify: true,
  }));
}

export function isSystemEmployeeName(name: string): boolean {
  return SYSTEM_EMPLOYEES.some((employee) => employee.name === name);
}
