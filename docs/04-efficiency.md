# Efficiency — making continuous execution affordable

Discussion doc. The governor stops us at 80%; efficiency decides how much work we got for that 80%.

The unit that matters is **useful work per unit of the scarce bucket** — not tokens saved for their
own sake. A change that halves token use but doubles rework is a loss.

---

## Ranked levers

### 1. Model mix — ~9× headroom shift
Covered in [01-decisions.md D3](01-decisions.md#d3--model-mix-opus-planner--sonnet-executor--opus-reviewer).
Nothing else on this list comes close. Config only, no fork.

### 2. Cold starts — the most under-appreciated cost

Continuous execution + a 5-hour halt cycle means **~4–5 session restarts a day**. Jinn's cron starts
a **fresh** session per fire, so each restart pays:

- re-reading the plan and the ledger
- re-orienting in the codebase (globs, greps, file reads)
- a cold prompt cache

Rough sizing: if a warmed working context is 50–100k tokens and it's rebuilt 5×/day, that's
250–500k tokens/day of pure re-derivation. Plausibly **20–30% of total spend**, doing nothing.

**Fix — compact, then halt, then resume the same session:**

1. Governor fires at 80% usage
2. Agent writes the handoff file (~1–2k tokens — cheap)
3. Agent runs `/compact` — history compresses, knowledge survives
4. Session halts
5. Cron resumes **that** session at reset via `--resume` (already supported in
   `claude-interactive.ts`)

This beats both alternatives. Resuming an *uncompacted* session re-sends a huge history as input on
every turn; starting *fresh* throws away everything the agent learned. Compact-then-resume keeps the
knowledge at a fraction of the context.

The handoff file becomes a safety net for when the session is genuinely unrecoverable, not the
primary mechanism. That's a change from the original plan — see
[01-decisions.md D4/D5](01-decisions.md#d4--resume-the-same-session-dont-spawn-a-fresh-one).

### 3. Effort tuning — bigger than model choice, within a tier

Executor at `medium`; planner and reviewer at `high`. Opus 5's `low`/`medium` are unusually strong —
prior-model defaults don't transfer. Sweep on real tasks before committing, and re-sweep after any
prompt change. Jinn supports per-phase engine *and* model selection in workflows, so this is config.

### 4. Delete the verification scaffolding — free savings

Opus 5 verifies its own work unprompted. Instructions that *tell* it to verify ("include a final
verification step", "double-check your answer", "use a subagent to verify") now cause
**over-verification with no capability gain**. This inverts the usual prompting advice, so any
prompt library we carry over needs a carve-out. It's a delete, not a rewrite.

Same applies to harness-level verification steps carried over from older models.

### 5. Cap subagent delegation

Opus 5 reaches for subagents readily — the opposite of Opus 4.8, which under-delegated. Each subagent
re-establishes context, re-explores, reports back, and then the coordinator re-reads the report. In a
continuous loop that compounds. Needs an explicit ceiling in the system prompt: delegate only for
genuinely independent, sizeable tracks; never to verify; keep spawn counts low.

### 6. Verbosity and deliverable length

Opus 5 writes longer responses *and* longer files on disk by default. A short conciseness instruction
cuts user-facing length ~20%; a separate deliverable-length instruction is needed for Markdown/reports
the agent writes. **`effort` does not reliably shorten visible output** — this has to be prompted.

### 7. Scope discipline

Opus 5 can expand task scope and add unrequested refactors. In a continuous unattended loop that's
pure waste, and it's also a *correctness* risk (see the security officer). An explicit
scope-discipline instruction reduces this to near-zero without producing excessive clarifying
questions.

### 8. The ledger is the memory — don't re-explore

The todo tree plus its comments should be the agent's **first read on resume**, ahead of the
filesystem. Structured state that already exists is orders of magnitude cheaper than re-deriving it
by exploring the repo. This is the economic argument for the todo ledger, separate from the
organizational one — and it's why the handoff file should point *into* the ledger rather than
duplicating it.

### 9. Keep the reporting layer off Opus

Stand-up narration is a background job on a fixed cadence. On Opus it silently competes with the work
itself. Haiku, or Sonnet at `low`. Cache keyed by `(project, department, latest-event-timestamp)` so
unchanged history is never re-summarized.

### 10. The telemetry layer itself is free

Worth stating plainly: the statusline recorder **runs locally and consumes no API tokens**. So the
entire sensing layer — usage %, context %, cost, reset times — costs nothing to collect. Make the GUI
event-driven (SSE, which Jinn already has via `work-items/live-events.ts` and `gateway-events`) rather
than polling, and the observability is genuinely free.

---

## Not available to us

- **`output_config.task_budget`** (the API's self-pacing token budget, beta, min 20k) — this is a
  Messages API parameter. Jinn drives the `claude` **CLI over a PTY**, so we can't set it. Don't chase
  it. Our equivalent is `effort` plus the governor.
- **Server-side compaction / context editing betas** — same reason; API-side only. We get Claude
  Code's own `/compact` instead.

---

## What to measure

Efficiency work without measurement is guessing, and we're already collecting the inputs:

| Metric | From |
|---|---|
| Cost per completed todo | `cost.total_cost_usd` ÷ todos closed (step 3 rollups) |
| Cold-start overhead | tokens spent before the first mutating tool call after a resume |
| Spend per department | session cost attributed via employee → department |
| Budget burn rate | `rate_limits.*.used_percentage` slope vs todos closed |
| Rework rate | todos reopened after review |

**Cost per completed todo, trending, is the single number to watch.** If it climbs, something in the
loop is re-deriving rather than remembering. Worth a small panel next to the stand-up.

---

## Open questions

- Does `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` disable auto-compact on a 200k model? If so, does
  our explicit compact-at-80% fully replace it, or do we also want to restore a sane auto-compact
  window? **Needs empirical test.**
- After a 5-hour gap the prompt cache is cold regardless (5-min default TTL, 1h max). Is there any
  value in a pre-warm call on resume, or is the compacted prefix small enough not to care?
- What's the real reviewer share once sub-tasks are realistically sized? The ~10% estimate is the
  weakest number in D3 and it's the one that decides whether the model mix holds.
- Does resuming a compacted session actually retain enough to skip re-orientation, or does it
  re-explore anyway? This determines whether D4 pays off. Test early — it's cheap to check.
