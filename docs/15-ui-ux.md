# UI/UX — what Jinn already looks like, and how Tengu extends it

Everything below is verified against actual source (`packages/web/`), not assumed from route names.
This corrects and replaces the earlier, pre-research sketch of a standalone "TelemetryBar" component
mounted globally — that doesn't fit the real nav shell, which deliberately has no persistent top bar.

---

## The existing design system (verified, not generic)

**It has a name in the code: "Ledger Dark" / "Ledger Light."** Not shadcn defaults — shadcn-scaffolded
(`components.json`) but heavily hand-customized. Two complete, deliberately-tuned palettes, dark as the
default, plus a `system` auto option, switched via a `data-theme` attribute and persisted to
`localStorage`.

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#14130F` (warm charcoal) | `#F4F1E8` (warm paper) |
| `--bg-secondary` | `#1E1C16` | `#FBF9F2` |
| `--bg-tertiary` | `#2A2720` | `#ECE8DC` |
| `--text-primary` | `#E8E4D8` | `#211E16` |
| `--accent` | `#E0A33C` (amber/gold) | `#926516` (darker ochre) |
| `--system-red` | `#E0675A` | `#B23B33` |
| `--separator` | `rgba(255,255,255,0.09)` | (paper-toned equivalent) |

Radii: `sm 6px / md 10px / lg 14px / xl 18px`. Spacing: 4px grid. Fonts: **Hanken Grotesk** (UI),
**IBM Plex Mono** (code/monospace figures). Frosted-glass "Apple Card" recipe (backdrop blur + saturate)
used for floating chrome. Extensive custom easing/keyframe system, `prefers-reduced-motion` respected.

**One explicit rule worth internalizing before designing anything new:** *"Active item = soft
`--fill-secondary` background, NEVER `--accent`."* Accent is reserved for meaning (the gold is
semantically "this matters"), not for navigation state. Any new UI should hold this line — don't reach
for accent color as a generic "selected" indicator.

**Nav shell** — not a sidebar, not a top bar:
- Desktop: a permanent **56px icon-only rail** (`NavRibbon`), 11 items, active state = soft fill only.
  Hovering an icon springs out a floating label ("piano reveal") rather than a permanently-expanded
  rail. Non-chat pages get two floating pills (title/back-nav left, page actions right) instead of a
  fixed header bar.
- Mobile: a bottom tab bar with ~4 primary items; everything else lives behind a `/more` overflow
  screen. No hamburger-plus-title mobile header — that pattern was explicitly removed.
- Rail footer already has a `WorkspaceSwitcher` + a theme-cycle button.

**Reusable patterns already built, worth knowing before designing anything new:**
- **Limits page's engine cards** — status-dot badge (green/gray/orange/red), threshold-colored progress
  bars (color shifts at 90%), tabular-nums percentages, reset countdowns. This is the closest thing to
  a stats-dashboard component in the app.
- **Cron page** — sections grouped by owner (there: employee), each a rounded container; rows with a
  status glyph, monospace schedule text, colored failure state, and a toggle.
- **Todo board's `card-tree.tsx`** — an expandable subtree toggle with a `closed/total` rollup badge.
- **Workflow's Runs lens** (`run.tsx`, `run-canvas.tsx`, `run-inspector.tsx` — a 20KB step inspector) —
  the existing pattern for visualizing multi-phase, multi-step execution.
- **`components/ui/quiet-card.tsx`** and **`state-line.tsx`** — small generic primitives.

**One real gap: no charting library at all.** No recharts, visx, d3-shape, chart.js, nivo. The only
`d3` dependency is `d3-hierarchy`, used purely for the org-chart tree layout, not for graphs. Everything
stats-like in the app today is hand-rolled `div`-width progress bars. This matters for anything that
wants a trend line (cost-per-todo over time, weekly pace) — see the open question at the end.

---

## Mockup

[mockups/limits-page.html](mockups/limits-page.html) — a real, standalone HTML file (open it directly
in a browser), not a description. Built with the actual verified tokens above: real embedded Hanken
Grotesk + IBM Plex Mono (not a system-font approximation), both themes properly implemented via
`data-theme`, the icon rail with the "active = soft fill, never accent" rule honored, and the exact
Ledger Dark/Light hex values from `globals.css`. Shows the extended Limits page — pacing strip, the new
per-session cards alongside the existing per-engine cards — plus smaller previews of the Stand-up
grouped-list pattern and the sub-sub-task verify glyph, both labeled as new. Toggle light/dark with the
icon in the rail footer.

---

## What changes, screen by screen

### 1. Governor + telemetry — extend Limits, don't add a bar

**Correction to the earlier plan:** step 2 originally proposed a `TelemetryBar.tsx` "mounted in the
shared layout." Having now seen the real shell, that's wrong — there is no persistent top bar anywhere
in the app, by deliberate design (floating pills instead). Bolting one on would be the single most
visible way to make Tengu feel like a different app grafted onto Jinn rather than a natural extension.

**What to build instead**, using patterns already there:

- **Ambient, always-visible signal:** a small colored status ring/dot on the **Limits rail icon itself**
  (`Gauge`), reflecting current governor state (green/amber/red — same three-color language Cron and
  Limits already use for status dots). Zero new chrome, glanceable from any screen, exactly the "how
  much limit is remaining" ambient awareness originally wanted — without inventing new UI surface.
- **Full detail: extend the existing Limits page**, don't build a parallel one. It already has exactly
  the right visual vocabulary — status-dot cards, threshold-colored progress bars, reset countdowns.
  Add:
  - A **per-session card section** (today's cards are per-*engine*; add per-*session* cards showing
    model, current todo, context-window %, using the identical card/progress-bar pattern).
  - A **pacing state strip** at the top of the page — current mode (accelerate/hold/throttle) and *why*
    ("weekly pace 1.3× budget"), reusing the page's existing status-badge language rather than a new
    component.
  - A **fan-out state line**, same treatment — degree, and the reason if sequential.

This reuses ~90% of an existing, well-built page instead of inventing a new persistent surface, and it
keeps the "no fixed bars" rule intact.

### 2. Stand-up — a new route, following the Cron page's grouping pattern

Doesn't fit inside Org (that's a hierarchy visualization, not a report) or Limits (that's per-engine
quota, not project progress). New route, added to `nav.ts` and `PillNav` — a `Newspaper` or
`ClipboardList`-style icon would fit the existing lucide-react set.

Layout follows **Cron's already-established grouped-list pattern**, just re-keyed: Cron groups rows by
*employee*; Stand-up groups rows by *project*, with *department* rows inside each project section —
same rounded-container-per-group visual, same row shape. Each department row:

- Reuse the **Limits page's progress bar** (done/remaining, same threshold-coloring convention).
- A collapsed-by-default narrative — the scribe's "issues hit / how resolved" summary — expandable
  inline, same interaction as the todo card's subtree toggle. Don't show prose by default; the whole
  point of a stand-up is scannability, expand only on demand.
- Security-officer incidents and circuit-breaker trips render inline in the same row list, visually
  distinguished with `--system-red`, not a separate feed — they're part of "what happened," not a
  separate concern.

### 3. Council — needs no new UI at all

This is the best finding in the research. The council's "ask clarifying questions, wait for a reply"
requirement ([09](09-work-profile-and-council.md), [D11](01-decisions.md)) is just a normal
conversation with the `council` employee — Chat already handles exactly this, unmodified.

**The phase progress (intake → triage → consultation → synthesis → approval) has a stronger answer than
anything I'd have designed from scratch:** step 12 already specifies the council's output as a
**generated Jinn workflow**. Workflow already has a full **Runs lens** — `RunRow` list, `run-canvas.tsx`
visualizing a run on the flow canvas, and a 20KB `run-inspector.tsx` step inspector. Once the council's
phases run as workflow steps, that inspector renders the phase-by-phase progress **for free** — same
component, no new code. The council doesn't need a bespoke UI; it needs its execution modeled as a
workflow run, which step 12 was already going to do anyway.

### 4. Sub-sub-task checkpoints — deeper nodes in an existing tree, not a new concept

The todo board's `card-tree.tsx` already does expandable subtrees with a `closed/total` rollup badge.
Sub-sub-tasks are just depth-3 nodes in the same `parentId`/`rootId`/`depth` tree the board already
renders — no new visualization concept required.

One small, genuinely new affordance: a **verify-status glyph** per sub-sub-task row (checkmark-in-circle
/ empty-circle / spinner), using the same `RunGlyph`/status-dot visual language Cron and Limits already
use — consistent rather than novel, but it doesn't exist today and needs adding.

### 5. Security incidents — a lens on Activity, not a new page

Todos already has a per-task `ActivitySection` (event timeline + comments). For a *global* feed of
security-officer blocks, add a filtered lens on the existing `/logs` (Activity) route rather than a new
page — tag security events distinctly (icon + `--system-red`), reuse the page's existing timeline
renderer. This mirrors how the stand-up surfaces incidents inline rather than as a separate concern.

### 6. Profile switcher (personal/work) — likely already solved, needs verifying not building

The rail footer already has a `WorkspaceSwitcher`. **Open question, not yet resolved:** does it switch
between views of one gateway instance's data, or genuinely support pointing at separate
`JINN_INSTANCE`s on different ports? If the latter, this requirement may need **zero new UI** — just
wiring personal/work into whatever it already switches between. Check before designing anything new
here; building a parallel switcher when one may already exist would be the kind of avoidable duplication
this whole plan has tried to avoid elsewhere.

---

## What's genuinely new UI (the actual delta)

Everything above reuses an existing pattern. The honest list of what doesn't already exist in some form:

1. Per-session cards on Limits (new card variant, same visual system)
2. The pacing/fan-out state strip on Limits (new, small)
3. The Stand-up route itself (new route, existing grouped-list pattern)
4. The verify-status glyph on sub-sub-tasks (new glyph, existing visual language)
5. A security lens filter on Activity (new filter, existing renderer)
6. Possibly nothing for the profile switcher — pending verification

That's a small, honest surface — most of "how Tengu looks" is "how Jinn already looks," which is the
right outcome for a fork whose whole thesis (D1, D11) is reusing as much as legitimately possible.

---

## Open question: charting

Nothing in the app charts anything — every stat today is a hand-rolled progress bar. Tengu wants at
least one real trend line (cost-per-todo over time, from [04-efficiency.md](04-efficiency.md)'s "what to
measure" section; weekly pace-ratio over the week, from [08](08-pacing-controller.md)).

Two paths, not yet decided:

- **Hand-roll simple SVG sparklines**, consistent with the codebase's evident preference for small
  custom primitives over large dependencies (the only "big" libraries in the whole app are React Flow
  and Tiptap, both for genuinely complex canvas/editor needs — nothing comparable exists for a chart).
- **Add a lightweight charting library** if hand-rolling trend lines specifically (not just bars) turns
  out too fiddly to hand-roll well.

Lean toward hand-rolling given the codebase's own precedent, but this is a real decision to make once
the actual data shape is known, not now.
