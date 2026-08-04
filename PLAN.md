# ICI-678 — Chat image preview: full screen again, plus zoom / navigation / close

Branch `build/ICI-678-fullscreen-image-viewer`. Original base `7fd9f259`.
**This round reconciles that branch against current `main` (`27b6a213`) and lands it.**

> Note: `PLAN.md` is tracked on `main` and every build run overwrites it with its own plan.
> That is the pipeline's existing convention (main currently carries ICI-680's plan) and it
> is the sole reason the previous landing attempt stopped. Flagged as an adjacent problem
> at the bottom; not fixed here.

---

# Round 2 — reconcile and land

## Where this stands

The feature is **built and independently verified**. Round 1 (`run_2d3116cc`) ended with
verdict `ship` — 0 Blockers, 0 Majors, 0 Minors — with browser QA at both breakpoints in
both themes and eight screenshots attached to the Todo. The operator then approved the
merge and commented **"merge into main"**.

The landing did not happen. The landing phase had already completed when it hit an
unreviewed `PLAN.md` conflict against the newer `main`, so it could not resolve it. A
follow-up run (`run_d527b10b`) stalled in its plan node and never got to the merge.

So the work of this round is **not** to rebuild the feature. It is to reconcile the branch
with 26 commits of newer `main`, re-prove the gates on the merged HEAD, and land it.

## What the reconcile actually involves — measured, not assumed

```
git merge-tree --write-tree --name-only HEAD main
  → CONFLICT (content): PLAN.md          # the only conflicted path
```

- **Conflict set is exactly one file: `PLAN.md`.** No code conflicts.
- `main` has made **zero** changes since `7fd9f259` to any file this branch touches
  (`message-media.tsx`, `dialog.tsx`, `attachment-preview.tsx`, `components/ui/`).
- **No dependency drift**: no commits to `package.json`, `packages/web/package.json`, or
  `pnpm-lock.yaml` in `7fd9f259..main`.
- The regression's cause is **still present** on `main`:
  `chat-messages.tsx:1047` still carries `contentVisibility: "auto"`, and there is a test on
  `main` (`message-row-content-visibility.test.tsx`) asserting it. So the portal fix is still
  the right fix and is still needed.

Risk is therefore concentrated in one place: the merged HEAD must still pass the full web
suite and the design gate. That is what gets re-run, not re-argued.

## Steps

1. **Commit this plan** on the branch (`docs: plan ICI-678 reconcile`), so the merge has a
   clean tree to work with.
2. **`git merge main`** in the existing worktree. Resolve the single `PLAN.md` conflict by
   keeping **ours** (`git checkout --ours PLAN.md`) — this file. Do not hand-merge ICI-680's
   plan text into it; the convention is that the current run's plan lives here.
3. **Prove the merge changed no code.** `git diff 27b6a213..HEAD --stat` must list exactly
   the six feature files plus `PLAN.md`, with the same shape as before the merge.
4. **Re-run the gates on the merged HEAD** (see below).
5. **Re-run browser QA on the merged HEAD** (see below). The design bar is not inherited from
   round 1 — a merge changes the bundle, so the shots are retaken.

## Acceptance criteria for this round

1. **Merged.** `git merge-base --is-ancestor 27b6a213 HEAD` succeeds — current `main` is fully
   contained in the branch HEAD.
2. **Only `PLAN.md` was resolved by hand.** `git diff 27b6a213..HEAD --name-only` returns
   exactly: `PLAN.md`, `packages/web/src/components/chat/message-media.tsx`,
   `packages/web/src/components/chat/__tests__/message-media.test.tsx`,
   `packages/web/src/components/ui/dialog.tsx`,
   `packages/web/src/components/ui/image-lightbox.tsx`,
   `packages/web/src/components/ui/__tests__/image-lightbox.test.tsx`,
   `packages/web/src/routes/todos/task-page/attachment-preview.tsx`. Nothing else.
3. **The regression test still fails without the fix.** Revert the portal in
   `image-lightbox.tsx` on the merged HEAD, watch `message-media.test.tsx`'s containment
   assertion go red, restore it. Evidence per taste §5.1 — a green test alone proves nothing.
4. **`pnpm typecheck` clean** on the merged HEAD. Paste the verbatim tail.
5. **`pnpm --filter @jinn/web test` green** on the merged HEAD, full suite, not a focused
   subset. Round 1 needed `--maxWorkers=1` under host load; that is acceptable, but the run
   must be complete and the file/test counts reported.
6. **`pnpm build` clean** on the merged HEAD.
7. **Design gate re-verified on the merged HEAD.** Screenshots at **1440×900 and 390×844, in
   both light and dark**, covering: viewer open at 1×, viewer zoomed, and a multi-image
   gallery showing the arrows. Overlay covers the full viewport in every shot.
8. **Behaviour unchanged from the verified round-1 build.** Prev/next wrap, zoom resets on
   navigate, close via ×/Esc/backdrop/swipe-down, ctrl+wheel zoom with `preventDefault`,
   pinch clamped to `[1, 4]`.
9. **`packages/web/index.html` still contains `maximum-scale=1,user-scalable=no`** and no code
   path mutates the viewport meta. Grep-checkable.
10. **Leak-grep clean** on the staged diff before the landing commit.

## How it gets verified

- Gates run from the worktree root, **after** the final edit, with verbatim tails pasted.
- Browser QA via `jinn-sandbox.sh up qa-ICI-678 --build --seed` on **7778+**, driven with
  `agent-browser` under a **throwaway `AGENT_BROWSER_PROFILE`** (the shared `jinn-main` profile
  collides with parallel runs). Destroy the sandbox and delete the profile afterwards, even if
  the run fails.
- **Never** `pnpm dev` — its proxy reaches into 7777. **Never** port 7777 or 7788. **Never**
  touch the operator's live instance home. Kill only PIDs this run started.
- Real pinch cannot be produced by a headless driver, so pinch is exercised by dispatching
  synthetic two-pointer sequences via `agent-browser ... eval` against the live DOM.

## Out of scope for this round

- Any change to the feature's design or behaviour. It was verified `ship`; reopening it is a
  new Major against code already passed, which taste §5 rule 2 forbids.
- Removing or weakening `content-visibility: auto` on message rows — intentional perf.
- Changing the viewport meta in `packages/web/index.html`.
- Video, audio or PDF preview. Images only.
- The composer attachment strip (`chat/media-preview.tsx`).
- Fixing the tracked-`PLAN.md` churn (see below). Reported, not fixed.

## Adjacent problem, handed back not fixed

`PLAN.md` is a **tracked file at the repo root** that the build pipeline overwrites on every
run and lands on `main`. Consequence: any two build branches created from different bases
conflict on it, which is exactly what stalled this ticket for a day. Worth a follow-up Todo —
either gitignore it and write plans to an untracked path, or move plans under
`.jinn-build/<ticket>.md`. Not this ticket's job.

---

# Reference — the feature spec as built and verified in round 1

## What the operator asked for

> In chat, there is a regression for when I click on an image to expand it. It shows inside
> the chat container instead of full screen like it used to... please fix that.
>
> Also make the design and functionality of viewing images a bit better. For example I want:
> 1. to be able to zoom images (I think that is not possible since we set a global no pinch
>    zoom on mobile). Figure out how to enable zooming on them with pinching without disabling
>    the disable of global zoom pinch.
> 2. I want to go back and forth with arrows
> 3. easily close the full screen preview.

## Root cause of the regression (confirmed, not guessed)

`packages/web/src/components/chat/chat-messages.tsx` puts
`style={{ contentVisibility: "auto", containIntrinsicSize: "auto 120px" }}` on **every message
row**. It arrived in `d9eac83b` ("perf: harden web loading and Todo batching").

`content-visibility: auto` implies `contain: layout style paint`. **Paint containment makes the
element a containing block for `position: fixed` descendants.** The old chat lightbox was a
plain in-tree `fixed inset-0` div, so `inset-0` resolved against the message row instead of the
viewport, and the overlay was clipped to the chat column.

The fix is to render the overlay in a **portal to `document.body`**, not to remove
`content-visibility` (that is deliberate virtualisation perf and is not ours to undo).

## The approach

The Todos task page already had a full-screen image viewer doing most of what was asked
(`attachment-preview.tsx` `AttachmentLightbox`: Radix `Dialog` → portal to body, focus trap,
scroll lock, Esc; prev/next; click-to-zoom + pan; download; safe-area toolbar; Ledger tokens).

Chat is the **second caller**, which is exactly when taste §1 says to extract. So:

1. A shared `ImageLightbox` at `packages/web/src/components/ui/image-lightbox.tsx`, generic over
   `{ id, url, name }` items, keeping the existing `attachment-lightbox*` test ids so the Todos
   suite proves the migration is behaviour-preserving.
2. **Pinch-to-zoom** added to it — the one capability neither viewer had.
3. Both call sites point at it: chat `message-media.tsx` and todos `attachment-preview.tsx`.

### Pinch-to-zoom under a global `user-scalable=no`

`packages/web/index.html` sets `maximum-scale=1,user-scalable=no`. That stays untouched —
flipping it would let the whole dashboard pinch-zoom, which is what the meta exists to prevent,
and iOS Safari does not reliably re-apply a mutated viewport meta anyway.

Instead the viewer runs its **own** gesture layer, orthogonal to the page-level meta:

- `touch-action: none` on the image surface **while the lightbox is open**, so the browser hands
  us raw pointer events instead of consuming them for scroll.
- Live pointers tracked in a `Map`. Two pointers down → pinch: scale by
  `currentDistance / startDistance`, clamped to `[1, 4]`, anchored on the midpoint.
- One pointer down while `zoom > 1` → pan.
- Desktop trackpad pinch arrives as `wheel` with `ctrlKey` → same zoom path, `preventDefault()`
  so the browser does not page-zoom.
- Double-tap / double-click toggles 1× ↔ 2×.

### Navigation and close

- Prev/next buttons + `ArrowLeft`/`ArrowRight`; horizontal swipe at `zoom === 1` on mobile.
- Close: toolbar ×, Esc and backdrop tap via Radix, plus swipe-down-to-dismiss at `zoom === 1`.
- Gallery for chat = the images of that one message, so the arrows walk the attachments the
  operator actually clicked into.

## Files

| File | Change |
| --- | --- |
| `packages/web/src/components/ui/image-lightbox.tsx` | **New.** Shared viewer: Radix Dialog, gallery nav, pinch/wheel/double-tap zoom, pan, swipe, download, close. |
| `packages/web/src/components/ui/dialog.tsx` | `DialogContent` accepts `overlayClassName` so the viewer can style its backdrop. |
| `packages/web/src/components/chat/message-media.tsx` | Local `ImageLightbox` deleted; opens the shared one with the message's images as the gallery. |
| `packages/web/src/routes/todos/task-page/attachment-preview.tsx` | `AttachmentLightbox` is a thin adapter mapping `WorkItemAttachmentWire` → the shared item shape. |
| `packages/web/src/components/ui/__tests__/image-lightbox.test.tsx` | **New.** Gesture + navigation logic tests. |
| `packages/web/src/components/chat/__tests__/message-media.test.tsx` | Extended: portal target, containment regression, gallery nav from chat. |

Zoom/pan/pinch maths lives in small pure helpers in the new file so it is testable without a
real touchscreen.
