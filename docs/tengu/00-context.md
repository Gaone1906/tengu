# Context — what we're building and why

## Environment

- Claude Max 5x, $100/mo. Subscription, not API billing.
- Claude Code **2.1.185** at `/opt/homebrew/Caskroom/claude-code/2.1.185/claude` (Mach-O arm64).
- Node **v25.9.0** (Jinn needs 22+ — satisfied).
- `~/.jinn` does not exist; `jinn` not on PATH. Nothing installed yet.
- No statusline configured in `~/.claude/settings.json`.

## Requirements

1. Break large tasks into smaller tasks and sub-tasks.
2. Work the backlog **continuously** — a recursive code/test loop that keeps hammering.
3. Track usage limits and **stop at 80%**.
4. On hitting 80%: halt all agent execution, have each agent log its current work to a file, and
   **resume automatically** when the next 5-hour window opens (via cron).
5. Manage the context window — **compact at 80%** and create a handoff file so post-compaction the
   agent still knows what was done and what remains.
6. A Jinn GUI panel showing, constantly: context remaining per agent, usage limit remaining,
   overall work % complete, and work complete per agent.
7. A **stand-up** view: dashboard lists projects; within each, every department (backend, frontend,
   database…) reports done / remaining, issues hit, and how they were resolved.
8. A **security officer**: existing work is never wiped out; agents never run destructive commands.

All of it **autonomous — no user input**.

## Execution model

**Continuous, not concurrent.** One agent working a backlog without stopping, not a fleet in
parallel. This was clarified after the first draft and simplifies several things:

- No git worktree isolation, no concurrent-write conflicts.
- Account usage rollup is just the single active session.
- Handoff halts and resumes one session, not many.
- The GUI is one live row plus history, not a fleet view.

It also changes which limit binds: a single agent hammering continuously **saturates each 5-hour
window**, so the 5-hour governor is the routine control path (fires several times a day), while the
7-day cap is what ends the week.

## The constraints this runs into

| Constraint | Consequence |
|---|---|
| Opus has its own small weekly bucket on Max (~15–35h vs ~140–280h general) | An all-Opus continuous loop dies in 2–4 days. Model mix is not optional. |
| Jinn's rate-limit `waiting` state clears only on a **user message** | Unattended auto-resume silently never happens unless this is fixed. |
| Jinn's cron starts a **fresh** session per fire | Every resume pays a cold context + cold cache rebuild. |
| `--dangerously-skip-permissions` + `autoApproveSafetyPrompts` | The command-policy deny-list is the *only* gate. |
| No first-class project entity (projects are `cwd` paths) | Stand-up needs a project identity added. |
| Jinn is beta, ~301 stars, effectively one maintainer | We own the fork. |
