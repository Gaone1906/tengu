---
name: todo-handling
description: Create, assign, update, review, and archive Jinn Todos through the typed work-item tools
---

# Todo Handling Skill

Use this skill for durable work ownership and status tracking. Todos are the live company ledger; Workflows are the reusable HOW. A Workflow run, delegation, cron fire, or connector may mint a Todo automatically, so search before creating a duplicate.

## Find the right Todo

- Use `list_work_items` for recent work or structured filters such as `status`, `source`, `assignee`, `department`, and `needsAttentionFor`.
- Use `search_work_items` when you have text or several filters. It requires at least one real filter.
- Use `get_work_item` before changing a Todo so you understand its acceptance criteria, assignee, source/provenance, verification policy, and current status.

The statuses are `backlog`, `assigned`, `executing`, `in_review`, `done`, `blocked`, `escalated`, and `cancelled`. Agent updates intentionally expose only `in_review`, `blocked`, `escalated`, and `done`; other lifecycle decisions stay on their owning surface.

## Create and assign

Create a Todo only for durable work that needs an owner or review trail:

```json
{
  "title": "Verify release candidate",
  "body": "Run the release checks and attach the evidence.",
  "acceptance": "Typecheck, tests, lint, and build pass with command output.",
  "assignee": "a-reviewer",
  "department": "engineering",
  "verifyPolicy": {
    "mode": "verify",
    "verifier": { "employee": "a-lead" },
    "maxRounds": 4
  }
}
```

1. Search for an existing item covering the same outcome.
2. Call `create_work_item` with a concise title, enough context to act, and testable acceptance criteria.
3. Use `assign_work_item` when assignment was not supplied or must change. Verify the employee with `get_employee` or `find_employees` first.
4. Use `delegate_task` instead when the assignee should start immediately; it can use an existing `workItemId` or mint and link a new Todo atomically.

Do not invent provenance or attach approval fields. Delegation, cron, workflow, connector, goal, and session bridges mint their own source records. Approvals use their separate authority surface.

## Keep status honest

- Worker finished and ready for review: `update_work_item` to `in_review` with a note naming artifacts, checks, and remaining risks.
- Cannot proceed without an external change: move to `blocked` and state the concrete blocker plus what would unblock it.
- A manager/operator decision is required: move to `escalated` and summarize the options and recommendation.
- Reviewer accepts the work: move it to `done` with the verification evidence.
- Never mark your own produced work `done`; the reviewer owns completion. Do not use `done` to hide partial work or a failed verification.

Example:

```json
{
  "id": "wi_example",
  "status": "in_review",
  "note": "Implemented the requested change; typecheck, tests, lint, and build are green. Evidence is attached to the child session."
}
```

Use `archive_work_item` for obsolete or historical clutter while preserving its row and audit trail. Cancellation is a human lifecycle decision, not an agent status shortcut.

## Review loop

1. Reviewer calls `get_work_item` and inspects the linked session/workflow evidence.
2. If acceptance fails, send precise feedback to the worker session and keep the Todo out of `done`.
3. Repeat only within the declared `verifyPolicy.maxRounds` or the task's round cap.
4. When the cap is exhausted, move to `escalated` with the current result, failed criteria, and decision needed.

Report Todo id, title, assignee, status, verification result, and next owner. Do not create a second Todo merely because the first is blocked or under review.
