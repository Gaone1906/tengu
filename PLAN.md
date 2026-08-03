# ICI-678 — Chat image preview: full screen again, plus zoom / navigation / close

Branch `build/ICI-678-fullscreen-image-viewer` off `7fd9f259` (main).

> Note: this file previously held the merged ICI-225 plan. Replaced, per the pipeline
> convention that `PLAN.md` at the worktree root is the current run's plan.

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

`packages/web/src/components/chat/chat-messages.tsx:1026` puts
`style={{ contentVisibility: "auto", containIntrinsicSize: "auto 120px" }}` on **every message
row**. It arrived in `d9eac83b` ("perf: harden web loading and Todo batching").

`content-visibility: auto` implies `contain: layout style paint`. **Paint containment makes the
element a containing block for `position: fixed` descendants.** The chat lightbox
(`message-media.tsx:99`) is a plain in-tree `fixed inset-0` div, so `inset-0` now resolves
against the message row instead of the viewport, and the overlay is clipped to the chat column.

The fix is to render the overlay in a **portal to `document.body`**, not to remove
`content-visibility` (that is deliberate virtualisation perf and is not ours to undo).

## The approach

The Todos task page already has a full-screen image viewer that does most of what is being
asked — `packages/web/src/routes/todos/task-page/attachment-preview.tsx:127` `AttachmentLightbox`:
Radix `Dialog` (so: portal to body, focus trap, scroll lock, Esc), prev/next buttons, arrow-key
navigation, click-to-zoom + pan, download, safe-area toolbar, all on Ledger tokens.

Chat is therefore the **second caller**, which is exactly when taste §1 says to extract. So:

1. Extract a shared `ImageLightbox` to `packages/web/src/components/ui/image-lightbox.tsx`,
   generic over `{ id, url, name }` items, keeping the existing `attachment-lightbox*` test ids
   so the Todos suite proves the migration is behaviour-preserving.
2. Add **pinch-to-zoom** to it (the one capability neither viewer has today).
3. Point both call sites at it: chat `message-media.tsx` and todos `attachment-preview.tsx`.

### Pinch-to-zoom under a global `user-scalable=no`

`packages/web/index.html:5` sets `maximum-scale=1,user-scalable=no`. That stays untouched —
flipping it would let the whole dashboard pinch-zoom, which is what the meta exists to prevent,
and iOS Safari does not reliably re-apply a mutated viewport meta anyway.

Instead the viewer implements its **own** gesture layer, which is how every serious lightbox
does it and is orthogonal to the page-level meta:

- `touch-action: none` on the image surface **while the lightbox is open**, so the browser hands
  us raw pointer events instead of consuming them for scroll.
- Track live pointers in a `Map`. Two pointers down → pinch: scale by
  `currentDistance / startDistance`, clamped to `[1, 4]`, anchored on the midpoint so the image
  zooms around the fingers rather than around its centre.
- One pointer down while `zoom > 1` → pan (already implemented; reuse it).
- Desktop trackpad pinch arrives as `wheel` with `ctrlKey` → same zoom path, `preventDefault()`
  so the browser does not page-zoom.
- Double-tap / double-click toggles 1× ↔ 2× (already implemented; reuse it).

### Navigation and close

- Prev/next buttons + `ArrowLeft`/`ArrowRight` — already implemented, carried over.
- Horizontal swipe at `zoom === 1` navigates (mobile has no arrow keys).
- Close: existing toolbar ×, Esc and backdrop tap via Radix, plus swipe-down-to-dismiss at
  `zoom === 1`.
- Gallery for chat = the images of that one message, so the arrows walk the attachments the
  operator actually clicked into.

## Files

| File | Change |
| --- | --- |
| `packages/web/src/components/ui/image-lightbox.tsx` | **New.** Shared viewer: Radix Dialog, gallery nav, pinch/wheel/double-tap zoom, pan, swipe, download, close. |
| `packages/web/src/components/chat/message-media.tsx` | Delete the local `ImageLightbox`; open the shared one with the message's images as the gallery. |
| `packages/web/src/routes/todos/task-page/attachment-preview.tsx` | `AttachmentLightbox` becomes a thin adapter mapping `WorkItemAttachmentWire` → the shared item shape. |
| `packages/web/src/components/ui/__tests__/image-lightbox.test.tsx` | **New.** Gesture + navigation logic tests. |
| `packages/web/src/components/chat/__tests__/message-media.test.tsx` | Extend: portal target, gallery nav from chat. |

Zoom/pan/pinch maths lives in small pure helpers in the new file so it can be tested without a
real touchscreen.

## Acceptance criteria

1. **Full screen.** Opening a chat image renders the overlay as a child of `document.body`, not
   inside the message row, and it covers the viewport regardless of the message row's
   `content-visibility: auto`. Test: assert the dialog's ancestry is `document.body` and is not
   contained by the `[data-message-id]` element.
2. **Containment regression is proven closed.** A test that renders `MessageMedia` inside a
   wrapper carrying `content-visibility: auto` and asserts the overlay escapes it. It must fail
   against the current in-tree overlay and pass after the portal.
3. **Pinch zoom.** Two `pointerdown`s on the image followed by `pointermove`s that increase the
   distance raise the applied scale above 1; shrinking returns it toward 1. Clamped to
   `[1, 4]` — no scale below 1, none above 4.
4. **Page zoom is still disabled.** `packages/web/index.html` still contains
   `maximum-scale=1,user-scalable=no`, and no code path mutates the viewport meta. Grep-checkable.
5. **Ctrl+wheel zooms and does not page-zoom.** A `wheel` event with `ctrlKey: true` on the image
   changes the scale and has `defaultPrevented === true`.
6. **Arrows.** With ≥2 images in one chat message: prev/next buttons and `ArrowLeft`/`ArrowRight`
   move through the gallery and wrap at both ends. With exactly 1 image, neither arrow renders.
7. **Zoom resets on navigate.** Moving to another image returns scale to 1 and pan to `(0,0)`.
8. **Close.** The × button, `Escape`, and a backdrop tap each unmount the dialog. At `zoom === 1`
   a downward swipe past threshold also closes it; at `zoom > 1` the same drag pans instead of
   closing.
9. **Todos preview is behaviour-identical.** `task-sections.test.tsx` and `task-page.test.tsx`
   pass unchanged — no edits to those files.
10. **Gates.** `pnpm typecheck` clean, `pnpm --filter @jinn/web test` green, `pnpm lint` clean.
11. **Design bar.** Screenshot-verified at **1440×900 and 390×844, in both light and dark**:
    zoomed-out, zoomed-in, and a multi-image gallery. Tokens only — no hardcoded colours; tap
    targets ≥34px; toolbar respects `env(safe-area-inset-bottom)`.

## How it gets verified

- **Unit** — vitest + jsdom. Pointer events are synthesised (`new PointerEvent(...)` with
  `pointerId`/`clientX`/`clientY`), which is enough for criteria 1–8 because the gesture maths is
  in pure helpers.
- **Manual/browser** — `jinn-sandbox.sh up qa-ICI-678 --build --seed` on 7778+, driven with
  `agent-browser` per the `jinn-design` skill, using a throwaway `AGENT_BROWSER_PROFILE`.
  Destroy the sandbox afterwards even if the run fails. Real pinch cannot be produced by a
  headless driver, so pinch is additionally exercised by dispatching synthetic two-pointer
  sequences via `agent-browser ... eval` against the live DOM, and the visual states are
  captured as screenshots.
- **Never** `pnpm dev` (proxies to 7777), never port 7777 or 7788, never touch the operator's
  live instance home.
- Leak-grep the staged diff before committing.

## Out of scope

- Removing or weakening `content-visibility: auto` on message rows — it is intentional perf.
- Changing the viewport meta in `packages/web/index.html`.
- Video, audio or PDF preview. Images only.
- The composer attachment strip (`chat/media-preview.tsx`) — thumbnails before send, a different
  surface.
- Any non-image attachment surface, and any other overlay in chat.
- Pinch-zoom anywhere outside the image viewer.
