# Organization

{{portalName}} supports an organizational structure with employee personas, departments, ranks, Todos, Workflows, and inter-agent sessions.

## Employee Personas

Employee files live at `~/.jinn/org/<department>/<name>.yaml`.

```yaml
name: alice
displayName: Alice
department: engineering
rank: senior
engine: claude
model: opus
persona: |
  You are Alice, a senior engineer focused on backend systems.
  You write clean, well-tested code and prefer simple solutions.
  You review PRs thoroughly and flag potential performance issues.
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Unique identifier (lowercase, no spaces) |
| `displayName` | string | yes | Human-readable name |
| `department` | string | yes | Department directory name |
| `rank` | string | yes | One of: executive, manager, senior, employee |
| `engine` | string | yes | Engine to use: "claude" or "codex" |
| `model` | string | no | Model override (default from config) |
| `persona` | string | yes | System prompt defining personality and behavior |

## Departments

Each department is a directory under `~/.jinn/org/` containing:

```
~/.jinn/org/engineering/
  department.yaml     # Department metadata
  alice.yaml          # Employee persona
  bob.yaml            # Employee persona
```

### department.yaml

```yaml
name: engineering
displayName: Engineering
description: Builds and maintains the product codebase.
```

### Todos and Workflows

Todos are deliberately authored work in the live ledger. Employees find and update their assigned Todos, move finished work to `in_review`, and use `blocked` or `escalated` only when they cannot proceed.

Workflows are reusable automations - the HOW. Use or propose one when the same job is repeatable, scheduled, event-driven, or multi-step. A Workflow invocation never creates, links, transitions, approves, or mutates a Todo. A Todo-status trigger is a one-way input; the resulting Workflow run is independent.

Workflow runs are durable records, not Sessions. Human approvals and cancellation belong to the Workflow run and never change a Todo.

## Ranks

| Rank | Privileges |
|---|---|
| **executive** | Full access. Can message any employee, modify org structure, create departments. {{portalName}} holds this rank. |
| **manager** | Can message employees in their department. Can assign and review department Todos. |
| **senior** | Can message employees in their department. Can update tasks assigned to them. |
| **employee** | Can update tasks assigned to them. |

## Communication

- **Downward**: Higher-ranked agents delegate work through sessions and Todos
- **@mentions**: Messages containing `@name` route to that specific employee
- **Todo-ledger**: Agents check and update their assigned Todos
- **Cross-department**: Executives and managers can delegate across departments when needed

## Default Organization

{{portalName}} ships with a single executive employee:

```yaml
name: {{portalSlug}}
displayName: {{portalName}}
department: executive
rank: executive
engine: claude
model: opus
persona: |
  You are {{portalName}}, the executive AI assistant and gateway administrator.
  You manage the organization, delegate tasks, and handle direct requests.
```
