---
name: delegation
description: Delegate tracked work and coordinate child sessions through Jinn's chain of command
---

# Delegation Skill

Use this skill when another employee or engine is a better fit for a bounded piece of work. Delegate across roles; use native sub-agents only for extra hands inside your own role. Prefer the chain of command for multi-layer work, while keeping every brief and stop condition explicit.

## Choose the target

1. Use `list_employees` for the roster, `find_employees` to filter by department/rank/engine, and `get_employee` to inspect persona, manager, and direct reports.
2. Select by role and persona fit, not novelty or a desire to spread work around. One employee can have several parallel sessions.
3. Delegate through the relevant manager when they should own decomposition and review. Direct delegation remains valid when it is the clearest route.

## Tracked work versus a quick session

Use `delegate_task` for company work that needs ownership, status, review, or a durable record. One call uses or mints the Todo, starts the child session, and links them:

```json
{
  "employee": "a-builder",
  "title": "Implement parser validation",
  "task": "Implement the specified validation. Acceptance: focused tests fail before the change, then the focused and full suites pass. Report changed files and command evidence.",
  "effortLevel": "medium",
  "idempotencyKey": "parser-validation-v1"
}
```

- Pass `workItemId` when an existing Todo already tracks the outcome.
- Use one stable `idempotencyKey` for retrying the same delegation. If a spawn fails after the Todo is minted, preserve and report the returned work-item id; do not blindly create another delegation.
- If you pass `attachments`, every entry must be a managed file ID returned by `list_files` — never workspace or absolute paths. Missing or stale managed file IDs are rejected before Jinn creates the Todo or child session. Attach only files the child genuinely needs.

Use `spawn_session` for a quick, untracked question or short consultation:

```json
{
  "employee": "a-reviewer",
  "prompt": "Review this schema choice and return the top two concrete risks. Do not modify files."
}
```

If the work is repeatable, scheduled, or a reusable multi-phase procedure, use or propose a Workflow instead of carrying the whole process in a delegation prompt.

## The child-session protocol

1. After `delegate_task` or `spawn_session`, tell your parent/user what was delegated and to whom.
2. END YOUR TURN. The child's reply wakes the parent session; never poll in a loop.
3. On a callback, use `read_session` for the latest bounded slice when the reply is not already present. If a callback appears missed, use `list_sessions` with `scope: "children"` once, then read the relevant session.
4. Use `send_to_session` for precise feedback or a follow-up. End the turn again while the child works.
5. Use `stop_session` only for a running descendant that should cease; stopping preserves its record and a later follow-up can resume it.

For long evidence, ask the child to write a report or artifact and summarize it. Do not pull an unbounded transcript into the parent context.

## Brief quality and review

Every delegation brief should state:

- the concrete outcome and why it matters;
- relevant files, references, constraints, and authority boundaries;
- acceptance criteria and required evidence;
- whether changes are allowed or the task is read-only;
- the effort level, deadline/budget, and explicit stop condition.

Review at the risk-appropriate level: TRUST for simple lookups, VERIFY for routine implementation, and THOROUGH for architecture, security, breaking, or irreversible work. Do not forward raw employee output without checking it at the chosen level.

Use bounded feedback loops: low effort up to 4 rounds, medium up to 8, high up to 12. When the cap is reached, stop and escalate with the Todo id, child session id, what passed, what failed, and the decision needed.

## External and operator boundaries

Default questions and approvals to the manager/COO. Escalate to the operator for money, irreversible actions, public communication, legal/security decisions, or an explicit manager escalation. A terminal instruction such as "finish" increases persistence toward the stated outcome; it does not expand authority.
