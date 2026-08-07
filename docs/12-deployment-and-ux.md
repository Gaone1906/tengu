# Deployment & UX

## The question is already half-answered by forking Jinn

"Web app or desktop app" implies two different codebases. Jinn only offers one architecture, and we
inherit it: **a local Node gateway (daemon) + a browser-rendered dashboard.** `jinn start` runs the
gateway and opens `http://localhost:7777` in your normal browser — there's no separate native binary,
no Electron, no Tauri anywhere in the upstream repo (confirmed: no `electron/`, `tauri/`, `desktop/`
directory; no native wrapper of any kind).

So it's a web app in the sense that matters — HTML/JS UI in a browser tab — but **not** a hosted one.
Nothing runs anywhere but your machine unless you deliberately point it elsewhere. That distinction is
worth being explicit about, because "web app" usually implies "someone else's server," and here it's
the opposite: it's local-first by construction, same as most dev tools (Grafana, Jupyter, etc.).

**The real question isn't the UI's shape. It's what keeps the daemon alive.**

---

## The gap that actually matters

Verified facts, not assumptions:

| Mechanism | Exists upstream? |
|---|---|
| `service do ... end` in the Homebrew formula (launchd registration) | **No** |
| systemd unit anywhere in the repo | **No** |
| pm2 / process-manager config | **No** |
| Docker `restart: unless-stopped` | Yes — but Docker's restart policy only survives *container* crashes, not a *host* going to sleep |
| Docker port binding | `127.0.0.1` **only**, deliberately — "prevents exposing agent control to the wider network" |
| Remote-device pairing | `pairing-challenge.ts` is a **local filesystem proof** ("the proof file must be reachable only by the operator running the gateway") — this authenticates the local operator, not a phone on the network |

Put together: **upstream Jinn's whole posture assumes one trusted operator, on one machine, watching a
browser tab they opened themselves.** That's exactly the supervised-autonomy assumption from
[11-deviation-assessment.md](11-deviation-assessment.md) — same root cause, showing up again at the
infrastructure layer instead of the application layer.

For requirement 2 (continuous, unattended, overnight), this matters concretely: `node-pty` sessions are
real child processes. **Close the laptop lid and the OS suspends them along with everything else** —
the agent doesn't pause gracefully, it just stops existing mid-unit. No amount of governor logic
recovers from that; it's below the layer we're governing.

---

## Two problems, cleanly separable

1. **Keep the daemon running** — survive login, crashes, and (if the host is a laptop) sleep.
2. **Check on it without opening a laptop** — see governor state from your phone, get notified on halt.

Solve (1) first; (2) is optional polish layered on top, not a redesign.

### Problem 1 — keep it running

| Option | What it buys | Cost |
|---|---|---|
| **A. Do nothing — run `jinn start` in a terminal** | Works today | Dies the moment you close the terminal, log out, or the machine sleeps. Not viable for overnight. |
| **B. OS-level service supervision** — `launchd` (macOS) `.plist` or a systemd user unit (Linux), with `KeepAlive`/`Restart=on-failure` | Survives crashes and login. Standard, boring, well-understood | ~0.5 day. Ours to write — upstream has nothing to build on |
| **C. Keep the host awake while there's queued work** — `caffeinate` (macOS) / `systemd-inhibit` (Linux), asserted only while the pacing controller says there's something to do | Solves the sleep problem specifically | Must be **gated on governor state** — asserting it unconditionally defeats the pacing controller's own decision to idle overnight for weekly-budget reasons. Cheap once B exists to hook into |
| **D. Run the daemon on a machine that's already always-on** — a spare Mac mini, an old desktop, a small cloud VM — and treat your laptop as just a browser client | Makes B and C moot; the daemon's uptime stops being coupled to whether you're using your laptop | Needs a second machine, or ongoing cloud cost |

**B is required regardless of everything else.** C is the pragmatic zero-extra-hardware answer and
composes directly with the pacing controller we already designed — it should assert "stay awake" only
when the controller isn't intentionally idling, which is a small addition to
[08-pacing-controller.md](08-pacing-controller.md), not a new subsystem. D is the durable answer if
this becomes a serious daily driver — genuinely worth it once you're tired of remembering to leave the
laptop plugged in and open.

**Recommendation: B always, C now, D when it stops being a novelty.** Don't build D speculatively —
it's a config decision (point `JINN_HOME` at a different box, or just run the daemon there and open
the dashboard from wherever), not new code.

### Problem 2 — checking on it remotely

Upstream deliberately binds to loopback and authenticates via local filesystem proof — by design, you
cannot open the dashboard from your phone without changing something. Two honest paths, not a build
decision to make blind:

- **Tunnel to it** (Tailscale, WireGuard) — reach the loopback-bound port securely from another device
  without ever exposing it to the open internet. This is the right answer if D (always-on host) is also
  in play — a Tailscale-reachable Mac mini is genuinely check-from-anywhere.
- **Leave it local-only** — the telemetry bar and stand-up exist specifically so a glance at the laptop
  answers "is it working," which may be all you actually want.

**Don't decide this speculatively.** It's a five-minute Tailscale install whenever you actually want it,
not something to design around now.

---

## What I'd explicitly rule out: an Electron/Tauri wrapper

Considered and rejected, for three reasons:

1. **It doesn't solve the actual problem.** The daemon still has to be running somewhere; wrapping the
   same browser UI in a native shell doesn't change that. You'd still need B (and C or D) underneath it
   — the wrapper adds nothing to the part that's actually broken.
2. **It's the single most against-the-grain thing we could add.** Everything else in this fork touches
   Jinn's internals in isolated, minimal-surface modules (D1, D11's mitigation). A desktop wrapper is a
   parallel codebase with its own build, packaging, code-signing/notarization, and auto-update pipeline
   — permanently divergent, nothing to merge back, all ours to maintain forever.
3. **The thing people actually want from "a desktop app" is ambient status, not a different UI.** A
   pinned browser tab plus a real OS notification on halt/resume/council-needs-input gets you 90% of
   the felt benefit for a fraction of the cost.

That last point is worth its own line:

### The actually-worth-it lightweight version

A **menu-bar/tray status glancer** — not an app wrapper, a ~50-line polling script:

- macOS: a tiny `menubar`-style icon (or even just `osascript`/`terminal-notifier`) polling the
  gateway's existing telemetry endpoint, showing current state (running / paused / halted, % used,
  time to next reset) and firing a native notification on state changes worth interrupting for — halt,
  resume, and specifically **council awaiting your reply**, since that one silently stalls the whole
  pipeline if missed.
- It's a client of the API we're already building for the web dashboard. No new backend surface.

This is genuinely valuable and genuinely cheap — worth building, just not as step 0 of this decision,
and not disguised as "we need a desktop app."

---

## What the user actually has to do (the recommended path)

Concretely, once built:

```bash
npm install -g tengu-cli
tengu setup                    # probes engines, writes config, seeds the org
# one-time: install as a launchd/systemd service (a `tengu service install` we add)
tengu service install
tengu service start
```

Then: open `http://localhost:7777` (or the LAN/Tailscale address if using D) in a normal browser tab,
bookmark it. That's the whole "run" step, once. From then on:

- The service restarts itself on crash and on login, per B.
- `caffeinate`/`systemd-inhibit` keeps the host awake exactly while there's governed work to do, per C.
- The dashboard is a page you check, not an app you open — same posture as checking a Grafana board.

No separate install for "the app." The web UI *is* the app; the only thing genuinely missing from
upstream is making sure the thing serving it doesn't die when you're not looking at it.

---

## What this adds to the plan

New **step 13 — process supervision**, small and mechanical:

- `launchd` `.plist` (macOS) / systemd user unit (Linux) with restart-on-failure. ~0.5 day.
- `caffeinate`/`systemd-inhibit` wrapper, gated on pacing-controller state (don't keep the machine
  awake through an intentional idle stretch). ~0.5 day, and it's a small addition to
  `shared/pacing-controller.ts`, not a new module.
- `tengu service install/start/stop/status` CLI subcommands wrapping the above.

**Deferred, not scoped yet:** the tray/menu-bar status glancer. Real value, but it's additive polish
that can land any time after the core loop works — no reason to block on it.

---

## Open questions

- **Where does this actually run day-to-day** — your primary laptop, or a dedicated always-on box? This
  changes whether step 13's sleep-prevention piece matters at all (moot if D). Worth deciding before
  building C.
- Does the **work profile** (separate services, separate repos, [09](09-work-profile-and-council.md))
  change the calculus toward D? Multiple service repos plus the council's fan-out consultation phase is
  a heavier, longer-running workload than the personal profile — more reason to want a machine that
  doesn't care whether your laptop is open.
- If remote checking matters, Tailscale is the default answer — but confirm before adding it as a
  dependency anywhere in setup docs.
