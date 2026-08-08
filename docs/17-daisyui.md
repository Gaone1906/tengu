# DaisyUI — the real conflict, and what to do instead

## The collision, concretely

DaisyUI is a Tailwind plugin that ships its own theming mechanism: it switches themes via a
**`data-theme` attribute on `<html>`**, with built-in theme *names* like `"light"`, `"dark"`,
`"dracula"`, `"synthwave"`, `"night"`, `"cyberpunk"`.

Jinn's own theme system — verified in [15-ui-ux.md](15-ui-ux.md) — **already uses `data-theme` on
`<html>`** for its own Ledger Dark/Light switch, set by `ThemeProvider` in `src/routes/providers.tsx`.

That's not a stylistic clash, it's the same attribute, on the same element, driving two unrelated CSS
variable systems. And it's worse than "just pick different names" — daisyUI ships built-in themes
literally *named* `"dark"` and `"light"`, the same names Jinn already uses. Installing both means two
different color systems both firing on `data-theme="dark"`, with whichever stylesheet loads last
silently winning. This is a real, specific, verifiable conflict — not a vague compatibility worry.

## What I'd actually do

**Don't install the daisyUI plugin.** Port the *palettes* — the specific named color themes that are
the actual thing being asked for ("their themes are super cool") — into Jinn's own token structure
(`--bg`, `--bg-secondary`, `--accent`, etc.), wired through Jinn's existing `ThemeProvider` rather than
daisyUI's mechanism. Practically: extend the theme-cycle button (currently dark → light → system) into a
small theme *registry* — still one `data-theme` value per theme, still Jinn's own switcher, just more
than two entries. A daisyUI-inspired palette becomes a new set of token values under
`:root[data-theme="synthwave"]` for example, styled the way Ledger Dark/Light already are, not imported
as a competing system.

**What I'm not doing right now:** hand-typing specific hex values for named daisyUI themes into real CSS.
I don't have verified-current values in front of me, and given how much of this whole design process has
been "verify, don't guess," inventing plausible-looking hex codes for something that ships in production
CSS is exactly the wrong place to do that. Porting 2–3 real palettes with actual verified values is
concrete, bounded follow-up work — the mechanism above is the part worth deciding now; the specific
colors are a next step, not a guess to make today.

## What this is, decision-wise

Amends nothing — D16 already established "extend Jinn's existing screens, don't import a parallel
system." This is that principle applied to a specific request: take the *idea* (more theme options,
good ones), reject the *mechanism* (a second theming system fighting the first one for the same
attribute), keep it inside the pattern already decided.
