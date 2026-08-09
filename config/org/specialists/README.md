# Specialists

This directory intentionally holds no hand-authored employee YAML.

A specialist is a Sonnet-tier employee, `department: specialists`, that owns
exactly one repo and holds a persistent RAG-retrieved knowledge base of it
(see `docs/tengu/18-council-specialists.md`). Unlike generalists, specialists
are not written by hand here — they're created through the specialist
creation wizard (`web/src/routes/specialists/new.tsx`), because creating one
is a multi-step process a static YAML file can't express on its own:

1. name / repo / model / effort — the same fields any employee YAML has,
2. a **learning phase** — the wizard walks the repo (`knowledge-base/`)
   and builds the initial `vec0` embedding index for it,
3. a **teaching phase** — an interactive session (reusing the existing
   `interactive: true` mechanism) where the human can correct or extend
   what the specialist learned before it goes live.

The wizard writes the resulting employee YAML into this directory once
those steps complete, in the same shape `gateway/org.ts`'s `scanOrg` already
reads for every other employee. Two fields matter here that generalists
don't set:

- **`repo`** — absolute or `~`-relative path to the one repo this
  specialist owns. This is what makes an employee a specialist rather than
  a generalist (`Employee.repo` absent = generalist, not repo-scoped).
  `resolveSessionCwd()` uses it to pin every session this employee runs to
  that repo instead of `JINN_HOME`, which is also what confines the
  specialist's filesystem access to its own repo (`gateway/hook-endpoint.ts`
  reads the live process `cwd`).
- **`color`** — a hex color for round-table/avatar identity, so the
  round-table dashboard and org chart can visually distinguish specialists
  at a glance. Falls back to `web/src/lib/color-pool.ts`'s deterministic
  pool when unset.

If you're tempted to add a specialist YAML by hand: don't. Run the wizard
instead — it's the only path that also builds the knowledge base the
specialist needs to be useful, and a hand-written YAML with a `repo` but no
index behind it is a specialist that can't actually retrieve anything.
