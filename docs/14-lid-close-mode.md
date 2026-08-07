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

## The honest alternative

None of this fragility exists if the daemon runs on a rented box instead of the laptop —
[13-costs.md](13-costs.md) already priced that at **$40–48/month**. A VPS has no lid, no clamshell
logic, and sleeps only if explicitly configured to. If the dummy-display setup turns out flaky on your
specific machine, or this stops being worth the fiddling, that's the clean escape hatch already sitting
in the plan — not a new decision, just picking the option already priced.
