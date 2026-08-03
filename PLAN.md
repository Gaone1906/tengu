# ICI-680 — Jinn README refresh (copy + assets)

**Branch** `build/ICI-680-readme-refresh` · **Base** `ebaac281` (main)
**Mode** direct · **Complexity** complex

> This file replaces a leftover `PLAN.md` from ICI-225 that is tracked on `main`.

## The request (operator's words)

> Refresh README documentation, copy and assets. Assets including images are kind of
> old/stale compared to where jinn stands since then and how jinn looks like.
> Use agent-browser and what not or any skill that is available.
> **Do not refresh the gif.**

## What is actually stale

Verified against the repo at `ebaac281`, not assumed:

**Copy — root `README.md`** (last rewritten at 0.26, `8237caff`; package is now **0.29.0**)
- "Highlights from **0.26**" and "See CHANGELOG.md for the full **0.26** notes" — three
  releases behind. 0.27 (model-scoped Claude usage buckets), 0.28 (Workflows v2 explicit
  completion contract + run canvas, collaborative Todo hierarchy with labels/comments/
  attachments/links, multiple isolated workspaces, instance-wide MCP file reads, auth
  required by default) and 0.29 (grouped Todo work breakdowns in chat, one-root-per-outcome
  doctrine, instance directory permissions hardening) are all missing.
- **False claim:** "The picker shows real model names out of the box (Opus 4.8, GPT-5.5,
  Gemini 3.x…)". The shipped `DEFAULT_CONFIG` in `packages/jinn/src/cli/setup.ts` writes
  `Opus (Latest)` / `Sonnet (Latest)` / `Fable (Latest)`, `GPT-5.5 Codex`, `Grok Build`,
  `Gemini 3.5 Flash …`. Live discovery supplies the real Claude names; a fresh install does
  not show "Opus 4.8".
- The `config.yaml` example omits `gateway.authRequired: true`, which 0.28 made the default
  for new installs, and omits the `models:` registry block that is the actual answer to
  "how do I add a model without a code change".
- Roadmap "On deck" still lists **REST API auth**, which shipped in 0.28. Multiple
  workspaces shipped and is absent from "Shipped recently".
- Node prerequisite line ("22 or 24, avoid 25") must be re-checked against
  `packages/jinn/package.json` (`node >=22`) and `.nvmrc` (`24.13.0`).

**Copy — `packages/jinn/README.md`** (the page strangers see on npm) is far staler: it
describes Jinn as "Claude Code, Codex, Grok, and Antigravity" (no Pi, no Hermes) and never
mentions Todos, Workflows, or the MCP company surface. It is pre-0.26 text.

**Assets** (`assets/*.png`)
- `chat.png`, `org-map.png` — 23 Jun. `todos.png`, `workflows.png` — 19 Jul.
- `packages/web/src/routes/chat` has 17 commits since, `todos` 102, `workflow` 43.
- `chat.png` shows the composer chip reading "Opus 4.8 · Medium" — a model label the product
  no longer produces.
- `todos.png` predates hierarchy, labels, comments and links; it shows five flat rows.
- `org-map.png` truncates half its node labels ("Engineerin…", "QA & Rel…") and predates the
  system Todo Dispatcher employee.
- `jinn-showcase.gif` is **not touched** (explicit operator instruction).

## Acceptance criteria

1. **Version truth.** The Features section is headed by 0.29 (not 0.26) and the CHANGELOG
   link names 0.29. Every feature bullet that describes shipped behaviour is traceable to an
   entry in `CHANGELOG.md` between 0.26.0 and 0.29.0. No bullet describes behaviour that
   does not exist.
2. **Defaults match shipped code.** The model-names sentence matches the labels actually
   written by `DEFAULT_CONFIG` in `packages/jinn/src/cli/setup.ts`; every key/value in the
   README `config.yaml` example exists in that same `DEFAULT_CONFIG` with the same value,
   including `gateway.authRequired: true`; the Node prerequisite matches
   `packages/jinn/package.json` `engines.node` and `.nvmrc`.
3. **Roadmap is honest.** No item under "On deck" has already shipped (REST API auth is
   moved or removed), and "Shipped recently" names Workflows v2's completion contract, the
   Todo hierarchy, and multiple isolated workspaces.
4. **npm README is current.** `packages/jinn/README.md` names all six engines (claude, codex,
   grok, antigravity, pi, hermes) and mentions Todos, Workflows, and the MCP company surface.
   Its install and quickstart commands match the root README's.
5. **Assets regenerated.** `assets/todos.png`, `assets/workflows.png`, `assets/chat.png`,
   `assets/org-map.png` are re-captured from a build of this branch, dark theme, 2× DPR
   (≥2560px wide for the 880px-wide embeds), and each shows a surface that exists today:
   Todos with a sub-task/label present, the Workflows v2 canvas, Chat with the current
   composer and at least one activity receipt, the org map with **no ellipsis-truncated
   node label**.
6. **The gif is untouched.** `git diff --stat main -- assets/jinn-showcase.gif` prints
   nothing.
7. **Nothing personal ships.** The textual diff passes the leak grep, and no screenshot
   contains a real person's name, a real product name, an absolute personal home path, a real Slack ID,
   or any content from the live instance. All seeded demo data is invented and generic.
8. **Links resolve.** Every relative link and image path in both READMEs points at a file
   that exists on this branch (`CHANGELOG.md`, `LICENSE`, `.github/CONTRIBUTING.md`,
   `docs/engines-hermes.md`, `assets/*`).
9. **Scope is closed.** `git diff --stat main` lists only `README.md`,
   `packages/jinn/README.md`, the four PNGs, and `PLAN.md`. No product code, no template.
10. **Safety honoured.** The sandbox gateway ran on a port ≥7778 from an explicit throwaway
    `JINN_HOME`, its `config.yaml` `port:` was read and confirmed non-7777 *before* start,
    and the instance was destroyed afterwards — including if the run failed. `~/.jinn` and
    port 7777 were never written to, restarted, or stopped.

## Files

| File | Change |
|---|---|
| `README.md` | Features section retargeted to 0.29; model-name claim corrected; config example brought in line with `DEFAULT_CONFIG`; roadmap re-sorted; Node prerequisite verified; image captions checked against the new screenshots |
| `packages/jinn/README.md` | Rewritten to the current product: six engines, Todos, Workflows, MCP company surface, current quickstart |
| `assets/todos.png` | Re-captured |
| `assets/workflows.png` | Re-captured |
| `assets/chat.png` | Re-captured |
| `assets/org-map.png` | Re-captured, no truncated labels |
| `assets/jinn-showcase.gif` | **Untouched** |

## How the assets get made

1. Build this worktree: `pnpm install && pnpm build` inside
   `~/Projects/.worktrees/jinn-build-ICI-680`.
2. Bring up an isolated sandbox from *this* build with a `mktemp -d` home outside `~/.jinn`
   and an explicit port of 7793. Run setup with that exact `JINN_HOME`, edit only its generated
   `config.yaml`, then read the file back and confirm the parsed port is neither 7777 nor 7788
   before starting the daemon. Record the PID and stop only that instance with the same explicit
   `JINN_HOME`.
3. Seed a generic demo company into the sandbox home (invented names only — the existing
   assets use a "Northwind" COO over Engineering / Growth / Research / Support; keep that
   cast so the four images look like one company):
   - employees as YAML in the throwaway home's `org/` directory;
   - Todos, including one parent with sub-tasks and a label, through the sandbox gateway's
     own API on its own port;
   - a Workflow definition with sequential + parallel + approval nodes, and one completed
     run so the canvas has state;
   - a chat transcript inserted into the sandbox `messages` table
     (`packages/jinn/src/sessions/migrate.ts`) with the gateway stopped, then restarted —
     this is how a realistic conversation is staged without burning a real engine turn.
   Seed scripts live in the sandbox home, **not** in the repo.
4. Capture with `agent-browser` (see the `browser-use` skill) at viewport 1440×900, DPR 2,
   dark theme. Export a throwaway `AGENT_BROWSER_PROFILE` — `--session` does not isolate.
5. Crop only where the current assets are cropped (the org map is a wide strip).
6. Stop the daemon with the same explicit `JINN_HOME`, verify port 7793 is free, then remove the
   exact `mktemp` home and isolated browser profile — even if the capture failed.

## Verification

No new unit tests: this change has no logic. The full repository typecheck, test, and build
gates still run after the final edit; task-specific proofs are mechanical checks plus eyes on
the images.

```bash
cd ~/Projects/.worktrees/jinn-build-ICI-680
git diff --stat main                              # AC9 — only the six files + PLAN.md
git diff --stat main -- assets/jinn-showcase.gif  # AC6 — must be empty
# AC7 — run the required staged leak grep; only the repository-owner URLs may hit
pnpm typecheck
pnpm test
pnpm build
```

- **AC8**: extract every `](...)` and `src="..."` relative target from both READMEs and
  `test -e` each one.
- **AC1/AC2/AC3**: read the new copy next to `CHANGELOG.md` (0.26→0.29) and
  `packages/jinn/src/cli/setup.ts` `DEFAULT_CONFIG`, claim by claim.
- **AC5/AC7**: open each of the four PNGs and look at it. Check dimensions with
  `sips -g pixelWidth -g pixelHeight`.

## Out of scope

- `assets/jinn-showcase.gif` — the operator said not to.
- **Stale defaults in product code.** `DEFAULT_CONFIG` still ships `gpt-5.5` and
  `Opus (Latest)` while the current models are GPT-5.6 and Opus 5. That is a real problem
  and it is *not* this ticket: this ticket makes the README describe what ships, and hands
  the defaults back as a follow-up Todo.
- `CHANGELOG.md`, `.github/CONTRIBUTING.md`, `docs/**`, `packages/jinn/template/**`.
- Any product code or web UI change. If a screenshot exposes a UI bug, it is written down
  and handed back, not fixed here.
- Light-theme variants of the assets. The README's existing assets and the gif are all dark;
  the taste rule's dual-theme gate governs *design changes*, and this ticket changes no UI.
