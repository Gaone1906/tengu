# Costs — desktop wrapper effort, and hosting

Two independent questions, answered with numbers rather than vibes. Prices are current as of
2026-08-07 (search-verified, cite volatility where sources disagreed).

---

## 1. Desktop-app effort, as a multiplier on the plan

**Baseline: the plan as designed = 100** (21–33 days, per
[03-implementation-plan.md](03-implementation-plan.md)).

Two tiers of "desktop app," because they cost wildly different amounts and deliver wildly different
value:

### Naive wrap — not worth building

`BrowserWindow.loadURL('http://localhost:7777')` in Electron/Tauri, unsigned, no bundled daemon
lifecycle, no auto-updater. ~1–2 days. **Adds ~+5 to the total (→ ~105).**

This is exactly the version [D13](01-decisions.md#d13--local-web-app-not-a-desktop-wrapper-the-real-gap-is-daemon-supervision)
already rejected — it doesn't solve the actual gap (the daemon still has to be running), so the 1–2
days buys you a bookmark with extra steps.

### Production-grade — the honest number if you want a real one

What it would actually take to make a desktop wrapper that *does* something the browser tab doesn't:

| Piece | Days | Why it's not trivial |
|---|---|---|
| Bundle the gateway + rebuild native modules for Electron's ABI | 2–3 | `node-pty` is a native addon — Electron ships its own Node/V8 build, so every native dependency needs rebuilding against it (`electron-rebuild`), and re-breaks on every Electron major version |
| In-app process lifecycle management | 2–3 | Duplicates what `launchd`/systemd already do for free (step 13) — start/stop/health-check/restart, now reimplemented inside the app |
| Code signing + macOS notarization | 3–5 | Apple's notarization pipeline is a well-known multi-day debugging tax (entitlements, hardened runtime, stapling); **plus $99/year** ongoing for the Apple Developer Program — a recurring cost, not just engineering time |
| Auto-updater | 2–3 | `electron-updater`/Squirrel needs a release feed (GitHub Releases or S3), version-check logic, and testing the update-while-running case |
| Tray icon + native notifications | 1–2 | The thing people actually want from "a desktop app" — cheaper once the above exists |
| Edge cases: quit-vs-daemon-still-running, first run, crash reporting | 2–3 | The unglamorous part that eats a week on every real Electron ship |

**Total: 12–19 additional days.** On a 21–33 day baseline, that's roughly **+55 to +65 on the
100-scale** — call it **the total lands around 155–160.**

**And it's a permanent tax, not a one-time cost.** Every Electron major bump risks breaking the
`node-pty` rebuild; every macOS release risks a notarization requirement change; the $99/year doesn't
stop. This is the single most expensive thing on this list per unit of user-facing value — it's why
D13 recommends the tray-glancer instead (real ambient-status value, ~1–2 days, no signing pipeline, no
native-module rebuild, because it's a small standalone poller rather than a rehosted copy of the whole
UI).

**Number to take away: ~155 if you want it done properly. Don't build the naive version — it costs
real days for essentially nothing.**

---

## 2. Hosting — what it actually costs to run this unattended

### First, a sizing correction

The Android Studio comparison implies a GUI workstation. **Tengu doesn't need one.** Claude Code
drives `./gradlew build/test/assembleDebug` and `xcodebuild` directly via CLI — exactly how every CI
system (GitHub Actions, CircleCI) builds mobile apps, without ever opening an IDE window. No local LLM
inference either — every Claude call goes to Anthropic's API, so the box needs to be a solid **headless
dev/CI machine**, not a workstation with a GPU or a display.

What it actually needs to hold: `node-pty`'d `claude` CLI sessions (light — the model runs on
Anthropic's servers), git operations, `pnpm`/`npm` installs, test runners, linters, and — per D7 — this
is **sequential by default**, occasionally fanning to 2–3, not a CI matrix running everything at once.

**The one place this changes:** genuine iOS builds need real Apple hardware (Apple's EULA requires it,
virtualized or not), and a true GUI Android **emulator** (rather than headless CLI builds/unit tests)
needs hardware-accelerated virtualization most standard cloud VMs don't expose. Priced separately below
— don't pay for it unless you actually need it.

### Real prices, current as of 2026-08-07

| Provider | Spec | Price/mo | Note |
|---|---|---|---|
| **Vultr** | 4 vCPU / 8 GB | **$40** | Regular Performance tier |
| **Linode (Akamai)** | 4 vCPU / 8 GB | **$48** | |
| **DigitalOcean** | 4 vCPU / 8 GB (Basic) | **$48** | |
| **Vultr** | 4 vCPU / 16 GB | **~$96** | High Frequency tier |
| **DigitalOcean** | 4 vCPU / 16 GB (General Purpose) | **$126** | |
| **Hetzner** | 8 vCPU / 16 GB (CPX41) | **~$141** ⚠️ | See caveat below |
| **DigitalOcean** | 8 vCPU / 32 GB | **$252** | |
| **AWS EC2** | 8 vCPU / 32 GB (m6i.2xlarge, on-demand) | **~$280** | |
| **AWS EC2** | 8 vCPU / 32 GB (m7i.2xlarge, on-demand) | **~$294** | Newer generation, similar price |

⚠️ **Hetzner caveat:** multiple independent sources report a 2026 price hike of 107–204% driven by a
DRAM shortage — CPX41 reportedly went from **$46.49 → $141.49/month**. One pricing aggregator still
showed the old ~$0.06/hr rate (stale cache). **Hetzner's long-standing reputation as "the cheap option"
no longer automatically holds — check the live pricing page before committing**, don't trust cached
comparisons (including this one, by the time you read it).

### What I'd actually get

| Profile | Spec | Price/mo | Reasoning |
|---|---|---|---|
| **Personal** | 4 vCPU / 8 GB (Vultr, Linode, or DO Basic) | **$40–48** | D7's sequential-by-default posture — one repo, one active session, this is genuinely plenty |
| **Work** | 4 vCPU / 16 GB (Vultr High Frequency) or 8 vCPU / 16 GB | **$96–126** | 5 service repos checked out simultaneously, occasional D8 fan-out (cap 3), Android Gradle CLI builds (the Gradle daemon is memory-hungry) |

**Start at the smaller tier and scale up only if you actually hit swap/OOM** — same measure-don't-guess
posture as the fan-out circuit breakers in [07](07-fanout-policy.md). Don't pre-pay for 32GB on a
guess.

### If iOS or a real GUI emulator ever becomes a genuine need

A separate, meaningfully higher bracket — real Apple hardware, not optional:

| Option | Price | Notes |
|---|---|---|
| **AWS EC2 Mac** (mac2.metal) | $0.65/hr, **24-hour minimum host allocation** (Apple's EULA) | Billing starts on *allocation*, continues even if the instance is stopped, until you explicitly release the host. Running continuously: **~$468/month**. Built for burst CI triggers, not an always-on personal box — the 24h lock-in fights "spin up only when needed" |
| **MacStadium** | **~$79–199/month** depending on chip/RAM tier | Purpose-built for exactly this (iOS CI/CD); no 24h lock-in quirk; the realistic answer if this becomes real |

**If it ever matters: MacStadium at ~$100–150/mo, not AWS Mac** — AWS's billing model actively fights
the always-on use case you described.

### "I log into a website, close it, it keeps running forever"

This is precisely what [step 13](03-implementation-plan.md#13-process-supervision--1-day) already
builds — nothing new to design. On a rented Linux VPS: SSH in once (every provider above, including
Hetzner/DO/Vultr, ships a browser-based console in their dashboard, so "log into a website" is literally
accurate for setup), install Tengu as a systemd service with `Restart=always`, and it runs completely
detached from any browser tab or SSH session from that point on — closing everything doesn't touch it,
because systemd doesn't care whether you're logged in.

**Considered and set aside:** hosted dev-environment platforms (GitHub Codespaces, Gitpod) give the
"open a website, get a terminal" feel out of the box, but they're built to **auto-suspend on
inactivity** to control cost and bill per-hour rather than flat-rate — the opposite of what you want
for a 24/7 background agent, and the cost becomes unpredictable rather than a flat monthly number. A
plain VPS with our own systemd unit is simpler and matches the ask exactly.

### One real-world add-on cost worth flagging

Automated backup snapshots, if you want them, typically add **~20% on top of the base price** across
these providers. Not required, but worth knowing before being surprised by the first bill.

---

## Bottom line

- **Desktop app:** ~155 on the 100-scale for a real one; don't build the naive version.
- **Hosting, personal profile:** **$40–48/month.**
- **Hosting, work profile:** **$96–126/month.**
- **Add iOS/real emulator later:** **+$100–150/month** (MacStadium), separately, only when it's real.
- **"Runs forever after I close the tab":** already designed — step 13, a systemd unit, nothing new.
