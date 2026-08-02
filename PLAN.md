# ICI-225 — Variant A, slices 1 + 2

Base: `main` @ `d66b83439b9cb80edd35e9a28063d478445ba618`
Branch: `build/ICI-225-system-employees-dispatch`
Prior round: `docs/design/ICI-225-system-employees-and-dispatch.md` (audit + 3 variants).

## What the operator decided

The variants gate came back with the note **"A"**. That is a pick, not an abandon — Variant A,
*system employees are code*. This round builds the first two slices of A's own slice plan:

1. **Built-in registry** — system employees compiled into the bundle, merged under user YAML.
2. **Dispatch** — a button on a Todo that starts a Todo Dispatcher session which picks the
   employee and hands the work off.

Slices 3 (workflow routing) and 4 (Request update) are deliberately not in this round.

## One deviation from the design doc, stated up front

The doc's Variant A proposed a constrained Dispatcher output (`assign` / `start-workflow` /
`hire` / `ask` / `hold`) that the gateway would execute. **Not building that.** `delegate_task`
→ `POST /api/delegations` is already the atomic "model chooses, gateway performs" transaction,
it already accepts an existing `workItemId`, and it already has the mint-before-spawn and
idempotency work behind it. A second effect executor beside it would be a parallel delegation
path with exactly one consumer. The Dispatcher dispatches via `delegate_task`. The constrained
contract earns its keep in slice 3, when `start-workflow` makes it a genuine choice between two
targets — that is the right time to build it, not now.

## What changes

**Gateway**

- `packages/jinn/src/gateway/system-employees.ts` — **new**. A compiled-in
  `SYSTEM_EMPLOYEES` list with one entry, `todo-dispatcher`, plus a resolver that fills
  `engine` / `model` / `effortLevel` from `config.engines.default` so the Dispatcher runs on the
  user's default engine, as the Todo asks. Persona is generic prose (privacy firewall) telling
  it to read the Todo, pick with `find_employees`, hand off with
  `delegate_task({ workItemId, employee, task })`, then `comment_work_item` with the choice and
  the reason, then end the turn. `jinnMcp: true` — without the company toolset it has no hands.
- `packages/jinn/src/gateway/org.ts` — `scanOrg()` seeds from the built-ins, then merges user
  YAML on top. Rules, each of which is a test below:
  - `system` is never read from YAML. It is stamped by the built-in registry only.
  - A user YAML whose `name` matches a built-in may override **only** `engine`, `model`,
    `effortLevel`, `alwaysNotify`. Persona, rank, department, `mcp`, `jinnMcp`, `provides`,
    `reportsTo`, `cliFlags` keep the built-in values.
  - An override file legitimately has no `persona`. The existing `data.name && data.persona`
    guard would silently drop it — the built-in-name branch must run before that guard, not
    after.
  - `validateEmployeeUpdate` refuses non-knob fields for a system employee with an error that
    names the field. `updateEmployeeYaml` writes `<org>/system/<name>.yaml` when no file exists,
    containing `name` plus the knobs and nothing else.
- `packages/jinn/src/shared/types.ts` — `system?: boolean` on `Employee`, documented as
  gateway-stamped and never YAML-sourced.
- `packages/jinn/src/gateway/api.ts` — **new** `POST /api/work-items/:id/dispatch`. Spawns one
  `todo-dispatcher` session seeded with the Todo id, title, and body, links it to the Todo,
  returns its id. If a dispatcher session for this Todo is already live it returns that one and
  spawns nothing. Refuses with an explanatory 4xx if the resolved engine cannot attach the jinn
  toolset, rather than spawning a Dispatcher with no hands.

**Web**

- `packages/web/src/lib/api.ts` — `system` on the `Employee` wire type; `dispatchTodo(id)`.
- `packages/web/src/components/org/employee-editor.tsx` — a system employee renders a **System**
  badge; name, persona, rank, department are read-only; engine, model, effort stay editable.
- `packages/web/src/routes/todos/task-page/props-rail.tsx` + `task-page.tsx` — a **Dispatch**
  action in the rail beneath Assignee, built from the existing `RailRow` idiom (no new chrome,
  no hairline, tokens only). While a dispatcher session is live it reads as running and cannot
  double-fire.

## Acceptance criteria

1. With no org directory on disk at all, `scanOrg()` returns a registry containing
   `todo-dispatcher` with `system: true`, a non-empty persona, and `engine` equal to
   `config.engines.default`.
2. A user YAML for an ordinary employee that declares `system: true` loads with `system`
   undefined. A protected employee cannot be forged from disk.
3. A user YAML named `todo-dispatcher` that sets `model` **and** `persona` **and** `rank`
   changes the model only; persona and rank keep the built-in values. The same file with no
   `persona` key at all still applies its knobs and is not dropped.
4. `PATCH /api/org/employees/todo-dispatcher` with `{persona}` returns 400 naming `persona`;
   with `{model}` returns 200, and a following `scanOrg()` shows the new model with the built-in
   persona intact.
5. Deleting the override file returns the Dispatcher to its built-in knobs. It never disappears
   from the registry.
6. `POST /api/work-items/<id>/dispatch` on an open Todo spawns exactly one `todo-dispatcher`
   session, that session appears in `GET /api/work-items/<id>/sessions`, and the response
   carries its id. A second call while it is live returns the same id and spawns nothing.
7. The same route returns 404 for an unknown Todo id without spawning anything.
8. When the resolved engine cannot attach the jinn toolset, the route refuses with a 4xx whose
   message names the engine and what to change. No session is created.
9. On the Todo task page, Dispatch starts the Dispatcher and the page then shows the linked
   session; while it is live the action is non-repeatable.
10. The employee editor shows the System badge and read-only persona/rank/department for
    `todo-dispatcher`, with engine/model/effort still editable — screenshot-verified at
    1440×900 and 390×844 in **both** light and dark.
11. `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass, and the leak-grep over the staged diff
    is clean.

## How each is proved

- **1, 2, 3, 5** — `packages/jinn/src/gateway/__tests__/system-employees.test.ts` (new), driving
  `scanOrg()` against a temp `JINN_HOME`.
- **4** — extend `packages/jinn/src/gateway/__tests__/org-update.test.ts`.
- **6, 7, 8** — `packages/jinn/src/gateway/__tests__/dispatch-route.test.ts` (new), in the shape
  of the existing `delegations-route.test.ts`.
- **10 (DOM half)** — extend `packages/web/src/components/org/employee-editor.test.tsx`.
- **9, 10 (visual half)** — a throwaway sandbox: `jinn-sandbox.sh up qa-ICI-225 --build --seed`
  on 7778+, driven with `agent-browser`, then `destroy` — even if the run fails.

Criteria 2 and 8 are the security-shaped ones, so they follow the taste rule for closure claims:
write the test, revert the guard, watch it go red, put the guard back.

## Out of scope

- Slice 3: `start-workflow` routing, the label→workflow prior, shipped system workflows, a
  `workflows/` directory in the template.
- Slice 4: Request update, stalled-worker wake.
- Any other change to the Todos board or task page. Todos v2 shipped; this round adds one
  action and touches nothing else.
- Schema or migration work. Nothing here needs a table.
- A DELETE guard for employees. There is no DELETE route to guard, and `rm` is out of reach by
  construction — the built-ins have no file.

## Safety

- Runs entirely in this worktree. No gateway started outside an explicit throwaway `JINN_HOME`
  on 7778+; never 7777, never 7788, never `pnpm dev`.
- Privacy firewall applies hardest to `system-employees.ts`: its persona prose compiles into
  every user's install. Generic voice only — no real names, project names, or paths.
- The Todo body was read as data. It contains no injected instructions and no anomaly.
