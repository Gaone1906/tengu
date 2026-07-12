---
name: todo-handling
description: Create, assign, update, review, and archive Jinn Todos through the typed work-item tools
---

# Todo Handling Skill

Use this skill for durable work ownership and status tracking. Todos are the live company ledger; Workflows are the reusable HOW. A delegation, cron fire, or connector may mint a Todo automatically, so search before creating a duplicate. Workflow runs remain independent and never mint or own Todos.

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

Do not invent provenance or attach approval fields during creation. Delegation, cron, connector, goal, and session bridges mint their own source records.

## Approval flow

Approvals are routed records on a Todo, separate from its lifecycle status. Generic `update_work_item` does not perform approval decisions or review-bounce accounting; never use it as a substitute while an approval is pending.

1. The Todo owner or linked execution session, its manager, or the COO requests a decision with `request_work_item_approval`:

```json
{
  "id": "wi_example",
  "request": "Do the verification artifacts satisfy the acceptance criteria?"
}
```

   Omit `target` to use the default routed manager/COO. Repeating the identical pending request with the same target is idempotent and does not append another approval-requested event. A changed request or target replaces the pending route; there is no self-declared approval state on `create_work_item`.

2. The routed manager/COO decides with `decide_work_item_approval` and an optional evidence note:

```json
{
  "id": "wi_example",
  "decision": "approve",
  "note": "Acceptance checks and artifacts verified."
}
```

   The resolved routed owner cannot decide their own approval, but an employee hierarchy root/COO is exempt from that enforcement check. Linked execution alone is not checked, so routed managers/COO should avoid approving work they personally executed and use another authorized reviewer when possible. For a native approval on an `in_review` Todo, `approve` atomically records the decision and moves the Todo to `done`. `reject` records the critique, returns it to `executing`, and increments `rounds`; when the increment reaches `verifyPolicy.maxRounds`, it moves to `escalated` instead. Without an explicit limit, the effective ceilings are 2 rounds for `trust`/`verify` and 3 for `thorough`. On another status, the decision is recorded but status stays unchanged.

3. After a rejection, the worker revises the work, uses `update_work_item` to return it to `in_review`, and calls `request_work_item_approval` again for the next bounded review. Do not create a duplicate Todo.

4. If the routed manager/COO deliberately needs operator/aCEO authority, call `escalate_work_item_approval` with the pending Todo id and an optional reason. Escalation exposes the pending approval to that path; it does not approve or reject it.

Workflow and Todo approvals are separate authorities. Todo approval tools never resolve, project, or mutate Workflow gates; Workflow completion, failure, timeout, cancellation, and approval decisions never change a Todo. A `todo-status` Workflow trigger consumes only the immutable event and Todo id as provenance, never ownership.

## Keep status honest

- Worker finished and ready for review: `update_work_item` to `in_review` with a note naming artifacts, checks, and remaining risks.
- Cannot proceed without an external change: move to `blocked` and state the concrete blocker plus what would unblock it.
- A non-approval manager/operator decision is required: move to `escalated` and summarize the options and recommendation. For a pending approval, use `escalate_work_item_approval` instead.
- Reviewer accepts ungated work: move it to `done` with verification evidence. If an approval is pending, use `decide_work_item_approval` instead so the Todo approval consequence is recorded atomically.
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
2. If the Todo has a pending approval, use `decide_work_item_approval`; approve or reject with a precise evidence note.
3. After a rejection, the worker revises, returns the Todo to `in_review`, and requests the next approval. The rejection path increments rounds and auto-escalates when the effective limit is reached.
4. Use `escalate_work_item_approval` before the round cap only when the routed approver needs an operator/aCEO decision.

Report Todo id, title, assignee, status, verification result, and next owner. Do not create a second Todo merely because the first is blocked or under review.
