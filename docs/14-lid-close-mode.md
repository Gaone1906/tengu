# Keeping it running with the lid closed

**Correction to [12-deployment-and-ux.md](12-deployment-and-ux.md) and step 13 of the plan:**
`caffeinate` does not solve this. It only prevents *idle* sleep while the lid stays open. Closing the
lid fires a separate signal straight to `IOPMrootDomain` (macOS's kernel-level power controller), which
sleeps the machine by default — `caffeinate`'s power assertions never see that signal at all. Verified
against multiple independent, current sources, not assumed.

Concretely, this means: testing step 13 with the lid open proves nothing about what happens overnight.
The bug is silent — everything looks fine until the first time the lid actually closes.

---

## What actually works

macOS has one real supported path for lid-closed operation: **clamshell mode**, which requires an
**external display to be connected** — a real one, or a cheap dummy plug that reports display presence
without needing an actual screen. `caffeinate` and `pmset` are not what makes this work; the display
requirement is.

### The reliable combination

1. **A headless/dummy display adapter** (~$10–15, HDMI or USB-C/Thunderbolt depending on which port
   the machine uses for external video) — plugs into the display-out port and reports EDID display
   data so macOS believes a monitor is attached, without needing a real screen. This is the actual
   mechanism that satisfies clamshell mode, and it's the same trick used for running headless Mac
   minis as servers.
2. **Keep it on power.** Still the traditional clamshell requirement — Apple Silicon relaxed some
   constraints here, but plugged-in is safer and removes a variable.
3. **Unpair any Bluetooth keyboard/trackpad**, if this machine is being run purely as a headless box.
   A paired-but-disconnected Bluetooth peripheral is a reported cause of the Mac waking briefly to look
   for it and re-triggering sleep logic — confuses clamshell detection specifically.

That combination is what multiple independent reports converge on as actually reliable, as opposed to
fighting the OS with sleep-disable flags alone.

### Optional extra layer — with a real footgun attached

`sudo pmset -a disablesleep 1` sets a kernel flag that persists through lid-close and can be layered on
top of the above. Two things to know before using it:

- **It can leave the internal display on at full brightness under the closed lid**, burning power and
  generating heat, unless paired with separate display-sleep settings.
- **It persists until you manually clear it or reboot** — `sudo pmset -a disablesleep 0`. If this
  laptop is also your daily driver, forgetting to clear it means it won't sleep normally either — not
  in your bag, not overnight when you actually want it to. Worth a reminder note somewhere you'll
  actually see it if this machine does double duty.

Given that footgun, the dummy-display approach is the one to lead with; treat `disablesleep` as a
belt-and-suspenders addition, not the primary mechanism.

### `caffeinate`'s real, narrower job

Not useless — just not this. It's still correct to keep, gated on pacing-controller state per the
original step 13 design, for the case where the lid is **open** and the machine would otherwise idle-
sleep during the day while nobody's touching it. Just don't credit it with solving lid-close, because it
doesn't.

---

## Reliability caveat, stated plainly

Sources explicitly note this has gotten less predictable across macOS versions — pre-Sonoma behavior
was more permissive; current versions lean harder toward sleeping specifically to prevent thermal
buildup under a closed lid with no display. **Test it for real before trusting it**: set the dummy
display, disable sleep, close the lid, and let a session run overnight once, deliberately, before
relying on it for actual unattended work. Don't take any guide (including this one) as guaranteed
correct for your exact machine and macOS version — verify empirically, same as everything else in this
plan.

---

## The "Close Laptop Mode" toggle — good idea, wrong location

The footgun above (forgetting to clear `disablesleep`) is real, and a one-click toggle to set/clear it
is the right fix for it. The question is where that toggle lives — **not the web dashboard.**

### Why not a button in the web app

Concretely, not just cautiously: a browser tab has no way to trigger macOS's native privilege-auth
dialog. The gateway daemon serving that page runs as your normal user, not root, and there's no TTY for
a password prompt inside an HTTP request handler. To make a **web-reachable** button actually flip
`disablesleep`, there are exactly three ways to do it, and all three cost more than they're worth:

1. **A passwordless `sudoers` rule** (`NOPASSWD: /usr/bin/pmset -a disablesleep *`) — set up once, but
   from then on it's a **standing** elevated capability sitting behind an HTTP endpoint, not an
   authenticated one-time action. "The user authenticates each time" stops being true after setup.
2. **A signed privileged helper tool** (`SMAppService`) — the real macOS-native way to do this properly,
   but it pulls in the same code-signing + notarization pipeline (~3–5 days, **$99/yr ongoing**) that
   [13-costs.md](13-costs.md) already priced and D14 already declined for the desktop-app question.
   Same cost, same conclusion, different feature.
3. **Run the gateway daemon itself with elevated privileges** — the one to actively avoid. This daemon
   spawns Claude sessions with `--dangerously-skip-permissions` and executes AI-generated shell commands
   gated only by a regex deny-list (`shared/command-policy.ts` — already flagged in
   [11-deviation-assessment.md](11-deviation-assessment.md) as "a speed bump, not a sandbox"). Handing
   that same process root, even indirectly, multiplies the blast radius of the exact system the security
   officer exists to constrain.

None of these are hypothetical caution — they're the actual three options, and each one either breaks
the "authenticate each time" premise or reopens work already declined for good reason.

### Where it should live instead

A **local, native toggle** — not routed through the gateway at all. macOS already has the real
mechanism for exactly this, no code signing required for a script you run yourself:

```bash
osascript -e 'do shell script "pmset -a disablesleep 1" with administrator privileges'
```

`with administrator privileges` triggers the actual native macOS password/Touch ID prompt — this **is**
the "user authenticates" experience, just anchored locally instead of through a web request. (Verified:
this is standard, current AppleScript behavior — the search-flagged complications are about people
trying to *avoid* the prompt by hardcoding a password, which is the opposite of what we want here.) No
`sudo` prefix needed — the `administrator privileges` clause handles the elevation itself.

Two ways to ship it, smallest first:

1. **Two tiny scripts or macOS Shortcuts** — "Close Laptop Mode On" / "Off" — each just the one-liner
   above with `1`/`0`. Pin to the Dock, give each a keyboard shortcut. **Zero new code in Tengu.** Ships
   today, no build step.
2. **Two menu items on the deferred menu-bar status glancer** (D13) — same one-liner underneath, just
   wired into the tray icon we already scoped as future polish. Slightly nicer, still local-native,
   still no signing pipeline, since notarization is a *distribution* requirement — running your own
   unsigned script or menu-bar app locally isn't gated by it.

Ship (1) now if you want it immediately; fold into (2) whenever the glancer gets built.

---

## The honest alternative

None of this fragility exists if the daemon runs on a rented box instead of the laptop —
[13-costs.md](13-costs.md) already priced that at **$40–48/month**. A VPS has no lid, no clamshell
logic, and sleeps only if explicitly configured to. If the dummy-display setup turns out flaky on your
specific machine, or this stops being worth the fiddling, that's the clean escape hatch already sitting
in the plan — not a new decision, just picking the option already priced.
