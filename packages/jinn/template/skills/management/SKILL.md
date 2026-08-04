---
name: management
description: Manage departments, employees, hierarchy, delegation, and Todo ownership
---

# Management Skill

Use this skill to hire, fire, promote, move, or inspect employees and departments. Use `list_employees`, `find_employees`, and `get_employee` before changing the org so decisions reflect the resolved hierarchy and active roster.

Employee persona files live under `$JINN_HOME/org/<department>/<name>.yaml`; `$JINN_HOME` defaults to `~/.jinn`. Department metadata lives beside them in `department.yaml`. There is no org-write MCP surface, so make narrow filesystem edits and validate YAML before finishing.

## Persona contract

Required employee fields:

- `name`: unique kebab-case id matching the filename.
- `displayName`: human-readable name.
- `department`: parent directory name.
- `rank`: executive, manager, senior, or employee.
- `engine`: one of claude, codex, antigravity, grok, pi, hermes.
- `model`: optional engine-compatible model override.
- `persona`: focused role, expertise, boundaries, and reporting behavior.
- `reportsTo`: optional employee id for the explicit manager.

When `reportsTo` is omitted, the gateway infers a reporting chain from rank. Equal-rank employees never implicitly report to each other. Prefer an explicit manager, then the alphabetically first senior; omit the field when no suitable department lead exists.

```yaml
name: api-builder
displayName: API Builder
department: engineering
rank: employee
engine: claude
model: sonnet
reportsTo: engineering-lead
persona: |
  You build and test backend services. Escalate architecture decisions
  to your manager and report outcomes with command evidence.
```

## Operations

### Hire or create a department

Confirm the role, department, rank, engine, model, and persona. Create missing departments only with the user's agreement. Write the persona, verify that `get_employee` resolves it without warnings, and report the chosen manager.

### Fire

Inspect the employee with `get_employee`, including direct reports and parent. Surface active Todos before removal. Reassign direct reports to the departing employee's manager, or remove their `reportsTo` when the departing employee reports to the root. Reassign or block active work as directed, then remove the persona and verify the roster.

### Promote, demote, or move

Update rank or department and reconsider `reportsTo`. A new manager should normally own otherwise unassigned department members. When moving an employee, decide separately whether their direct reports move or stay; update active Todo ownership if needed.

Manager personas need only compact operating direction: own decomposition and review, use `delegate_task` for tracked work or `spawn_session` for quick consultation, end the turn while children work, use `read_session` only after a callback or as a missed-callback fallback, and synthesize results for the layer above. The `delegation` skill owns the full protocol.

### Delegate and review

Use `delegate_task` when assignment should start immediately. Use `create_work_item` then `assign_work_item` when authoring and assignment are separate. Keep repeatable or scheduled procedure in a Workflow, not a long delegation prompt. Review status through `list_work_items` or `search_work_items`; producers submit finished work for review and reviewers close it. The `todo-handling` skill owns status and approval rules.

## Guardrails

- Warn before deleting an employee, orphaning reports, or stranding active work.
- Reject duplicate employee ids and invalid report targets.
- Surface hierarchy cycles or cross-department warnings instead of hiding them.
- Preserve persona-specific expertise when adding manager responsibilities.
- Confirm the resulting employee, department, manager, and Todo ownership.
