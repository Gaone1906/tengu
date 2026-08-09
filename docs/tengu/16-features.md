# Tengu — final feature list (user's perspective)

The design phase is closed. Sixteen decisions logged in [01-decisions.md](01-decisions.md); this is the
plain-English summary of what it actually does and looks like, without implementation detail. See
[03-implementation-plan.md](03-implementation-plan.md) for how it gets built.

---

## What it does for you

- **Give it a big task and it breaks itself down** — project → task → sub-task → sub-sub-task,
  automatically, before any code gets touched.
- **Works the backlog continuously, unattended, including overnight.** You don't babysit it.
- **Never gets you cut off mid-week.** It paces its own usage against your Claude plan's 5-hour and
  weekly limits, so it neither wastes idle windows nor blows through the week by Wednesday.
- **Uses the right model for the job.** Cheap-and-fast for the actual coding grind, expensive-and-smart
  only for planning and review — roughly 9× more weekly runway than treating every step the same.
- **When it's about to run out, it stops cleanly** — wraps up, saves its place, and picks up exactly
  where it left off once your limit resets. Nothing gets redone from scratch.
- **If it's interrupted for any reason**, it only ever redoes the last few minutes of work, never a
  whole task — it checkpoints constantly under the hood.
- **Occasionally works on 2–3 things at once**, but only when it's confident it has spare budget and the
  tasks won't collide — otherwise it stays one-at-a-time on purpose, since that's actually the faster
  path over a full week, not the slower one.

## What you see

- **A status dot on the nav icon** — healthy, running low, or paused — glanceable from anywhere in the
  app, no need to open a page to check.
- **An extended Limits screen**: how much of your 5-hour and weekly usage remains, what each active
  worker is doing right now (which task, how full its memory is), and — in plain language — why it's
  currently speeding up, holding steady, or slowing down.
- **A Stand-up screen** — always-current, not a meeting you have to attend. Grouped by project, then by
  team (backend, frontend, mobile, whatever you've set up), each showing done/remaining and a
  plain-English note on any issues hit and how they got resolved. Collapsed by default; expand what you
  care about.
- **Expandable task trees** — every task shows its sub-tasks and sub-sub-tasks, each with a small
  checkmark, spinner, or empty circle showing whether it's verified done, in progress, or not started.
- **Nothing new to learn.** It's Jinn's existing app, extended — same look, same navigation, same
  screens you'd already recognize if you'd used the upstream tool. A warm, deliberate visual style
  (dark by default, full light mode too), not a generic dashboard bolted on top.

## Keeping it safe

- **A built-in security reviewer blocks destructive commands** — wiped git history, dropped databases,
  deleted files outside the project — before they run, not after.
- **Automatic restore points**, so even if something does slip through, you can roll back.
- **Every blocked action shows up as an incident in your Stand-up**, attributed and explained — never
  silently swallowed.

## Runs itself

- **Starts automatically when your computer boots, restarts itself if it crashes.** You never have to
  remember to start it.
- **A "Close Laptop Mode" toggle** (a tiny separate switch, not buried in the main app) lets you safely
  close the lid and keep it working, with a matching toggle to turn that back off.
- **It's free to run** — draws from your existing Claude subscription the normal way, not billed
  per-token.
- **No separate app to install.** A web dashboard you open in your browser, bookmark, and check like any
  other tool. If you ever want it on a dedicated always-on machine instead of your laptop, that's a
  simple switch later, not a rebuild.

## For multi-project / work use

- **Two completely separate instances** — personal and work — different settings, different task lists,
  different history, no crossover.
- **In the work instance, each of your services gets its own dedicated AI worker** that deeply knows
  that specific codebase, rather than one generalist juggling all of them.
- **A "council" feature for cross-service work**: describe a project that touches multiple services, and
  it asks you clarifying questions, works out which services are actually affected, consults each one
  individually, then comes back with a complete breakdown — and if two services' plans conflict, or
  something's needed that nobody's providing, it tells you *before* anything gets built, not after.
- **You always approve the plan** before code gets touched on anything cross-service. Nothing runs
  unattended until you've said go.

---

## Loose ends, closed

A few things were left open across the design docs. Resolved:

- **Running personal and work instances at the same time** shares one usage-budget tracker between them,
  so neither one accidentally spends the other's share.
- **When one service needs something from another**, that becomes a task for the service that owns it
  — not shared write access across services.
- **If a service's knowledge is out of date**, it's allowed to say so and investigate rather than guess.
- **Work that can't be mechanically verified** (a docs change, a style tweak) gets a lighter pass/fail
  check and is flagged as lower-confidence at review, rather than forced through a check that doesn't
  fit.
- **It runs on your laptop by default**, with the lid-close toggle above; checking it from your phone
  isn't built in at first, but it's a five-minute add whenever you actually want it.
- **Trend charts (cost over time, pacing over the week)** are simple and hand-built to match the app's
  existing look, rather than pulling in a new charting library for two graphs.

A small number of things can only be answered once it's actually running — not decisions to make now,
just the first things it'll tell us: whether the task-depth limit already fits the sub-sub-task level
without adjustment, whether the app's existing workspace switcher already handles instance-switching,
and what the real Opus-vs-Sonnet split looks like once genuine work is flowing through it. None of these
block anything — they're just where the plan meets reality on day one.
