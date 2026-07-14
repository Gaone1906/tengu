---
name: management
description: Manage the AI organization - hire, fire, promote, delegate, and review Todos
---

# Management Skill

## Trigger

This skill activates when the user wants to manage their organization: hiring or firing employees, creating departments, promoting or demoting staff, delegating Todos, reviewing work status, or restructuring teams.

## Organization Structure

The organization lives under the `org/` directory in the {{portalName}} home folder (`~/.jinn/org/`). Each department is a subdirectory containing employee persona YAML files and optional department metadata.

```
org/
  engineering/
    department.yaml
    lead-developer.yaml
    backend-dev.yaml
  marketing/
    department.yaml
    seo-specialist.yaml
```

## Rank Definitions

- **executive** - Full access. Can see all departments and Todos. Can hire and fire anyone across the entire organization.
- **manager** - Can manage their own department. Can hire within their department. Can review and assign department Todos.
- **senior** - Can update their own tasks. Can mentor other employees in the department.
- **employee** - Can update their own tasks only.

## Operations

### Hiring an Employee

Create a persona YAML file at `org/<department>/<name>.yaml`.

Required fields:
- `name` - kebab-case identifier (must match filename without extension)
- `displayName` - human-readable name
- `department` - department this employee belongs to (must match parent directory name)
- `rank` - one of: executive, manager, senior, employee
- `engine` - AI engine to use: `claude` or `codex`
- `model` - model identifier (e.g., `sonnet`, `opus`, `o3`)
- `persona` - multiline description of who this employee is and how they behave
- `reportsTo` - (optional) who this employee reports to (employee name)

**Auto-determining `reportsTo`** when the user does not specify:
1. Find the highest-ranked employee in the target department (manager > senior > employee)
2. If a manager exists → set `reportsTo: <manager-name>`
3. If only seniors exist → set `reportsTo: <first-senior-alphabetically>`
4. If the department is empty → omit `reportsTo` (smart defaults attach to root)
5. Confirm to the user: "Assigned X to report to Y. Change this?"

When the user specifies a report-to explicitly, validate the target exists in the registry. If not, warn and ask for correction.

Example (`org/marketing/seo-specialist.yaml`):

```yaml
name: seo-specialist
displayName: Sarah SEO
department: marketing
rank: employee
engine: claude
model: sonnet
reportsTo: marketing-lead
persona: |
  You are Sarah, an SEO specialist in the marketing department.
  You focus on keyword research, content optimization, and
  technical SEO. You report to the marketing manager.
  Your expertise includes Google Search Console, Ahrefs,
  and content strategy.
```

Steps:
1. Confirm the target department exists under `org/`. If not, ask the user whether to create it first.
2. Choose a kebab-case name for the employee (e.g., `lead-developer`, `seo-specialist`).
3. Ask the user for displayName, rank, engine, model, and persona if not provided.
4. Write the YAML file to `org/<department>/<name>.yaml`.
5. Confirm the hire to the user.

### Firing an Employee

1. Locate the employee's YAML file under `org/<department>/<name>.yaml`.
2. Check for active Todos assigned to the employee. Warn the user if any are not terminal.
3. **Check for direct reports**: Use `get_employee` to inspect the employee's `directReports` and `parentName` fields. Use `list_employees` if you need the broader department roster.
   - If they have direct reports: warn "X has N direct reports. They will be reassigned to X's manager (Y)."
   - On confirmation, update each report's YAML: set `reportsTo` to the fired employee's own `parentName` (their grandparent in the tree).
   - If the fired employee reported to root (parentName null), remove the `reportsTo` field from each orphaned report (smart defaults will re-resolve).
4. Delete the YAML file.
5. Reassign or block active Todos owned by the employee, based on the user's decision.
6. Confirm the removal to the user.

### Creating a Department

1. Create the directory `org/<dept-name>/`.
2. Create `org/<dept-name>/department.yaml` with:
   ```yaml
   name: dept-name
   displayName: Department Display Name
   description: What this department does.
   ```
3. Confirm the department creation to the user.

### Promoting or Demoting an Employee

1. Read the employee's YAML file at `org/<department>/<name>.yaml`.
2. Update the `rank` field to the new rank.
3. If promoting to **manager**, add delegation capabilities to their persona (see "Promoting to Manager" below).
4. Write the updated YAML back to the file.
5. Confirm the change to the user, stating the old and new rank.

### Promoting to Manager - Report Reassignment

When promoting an employee to manager rank:

1. Check if other department members currently report elsewhere (or have no explicit `reportsTo`).
2. Offer to reassign: "Promoting X to manager. Currently N employees have no explicit reporting chain in this department. Should they report to X?"
3. On confirmation, update each employee's YAML with `reportsTo: <new-manager-name>`.

Their persona must also be extended with delegation capabilities so they can manage their own reports. Append the following to their existing persona:

```yaml
persona: |
  [... existing persona content ...]

  ## Manager Responsibilities
  You are the manager of the [department] department. In addition to your
  technical expertise, you:

  - Manage and delegate tasks to employees in your department
  - Use `delegate_task` for tracked work and `spawn_session`
    for quick untracked child sessions
  - After delegating or spawning, end your turn and let the child's callback
    wake you; use `read_session` only as the missed-callback fallback
  - Apply oversight levels to your reports' work:
    - TRUST: simple lookups, status checks - relay directly
    - VERIFY: code changes, routine work - spot-check key outputs
    - THOROUGH: architecture, breaking changes - full review, multi-turn
  - Report summaries back to the COO ({{portalName}}), not raw employee output
  - Use Todos to track task status
  - Default to orchestrating through the right employee as the department
    grows; do the work directly only for tiny tasks where that is the cleanest path

  ## Delegation Tools
  - Delegate tracked work: `delegate_task`
  - Spawn a quick child session: `spawn_session`
  - Send follow-up: `send_to_session`
  - Read latest child status/messages: `read_session`
  - List or inspect reports: `list_employees`, `find_employees`,
    `get_employee`
```

**When to suggest promoting to manager:**
- A department has 3+ employees
- You're spending excessive time on per-employee delegation in that department
- A senior employee has consistently delivered high-quality work
- The user explicitly requests it

### Delegating Tasks

Create or delegate a Todo. Todos are the ledger; Workflows are the reusable HOW for repeatable or scheduled work.

Steps:
1. Verify the assignee exists in the org.
2. If the work is durable and owned by this session, create a Todo with `create_work_item` when MCP is available.
3. Assign the Todo with `assign_work_item`, or start the work immediately with `delegate_task` when it should execute now.
4. If the work is repeatable, scheduled, or multi-step, use or propose a Workflow instead of carrying the process in prose.
5. Confirm the delegation to the user.

### Reviewing Todos

1. List/search Todos for the department or assignee.
2. Present work grouped by status: backlog, executing, in_review, blocked, escalated, done.
3. Include priority and assignee for each task.
4. If the user wants to update status, use the Todo update path. Do not mark your own work done; the reviewer does that.

### Restructuring (Moving Employees Between Departments)

1. Read the employee's YAML from the source department.
2. Update the `department` field to the new department name.
3. Offer to update `reportsTo`: "Should X report to <new-dept-manager>?"
4. If the moved employee had direct reports, offer to reassign them to the next highest-ranked person in the old department.
5. Write the YAML to the new department directory.
6. Delete the YAML from the old department directory.
7. Reassign any active Todos owned by the employee, based on user preference.
8. Confirm the move to the user.

## Communication Rules

- Messages from higher-ranked employees can reference and direct lower-ranked employees.
- @mentions in messages (e.g., `@seo-specialist`) route to the mentioned employee's engine and model as defined in their persona YAML.
- An executive can message anyone. A manager can message employees within their department. Seniors and employees can message peers and their manager.

## Error Handling

- If a department does not exist when hiring, offer to create it.
- If an employee name conflicts with an existing file, warn the user and ask for a different name.
- Always validate YAML before writing to ensure it is well-formed.
