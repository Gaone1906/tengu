# ICI-660 — Todo detail: live-use feedback round

Base: `main` @ `b6f4bd30838dd006969be114886e36fe40941faa`
Branch: `build/ICI-660-detail-polish`

The list/board/create/detail redesign already merged (`b6f4bd30`). The operator then
used it live and filed three defects (comment `wic_04a6c376b9a3`, 2026-07-31, with
screenshot `Screenshot 2026-07-31 at 15.52.08.png`). This round fixes exactly those
three, on top of merged `main`.

---

## 1. Desktop detail page dumps everything on the left

> "Todo detail page on desktop shows everything in left hand side. The whole right
> hand side is empty. see screenshot."

**Cause.** `task-page.tsx:391` builds the document grid as
`w-full max-w-[920px] … lg:grid-cols-[minmax(0,1fr)_260px]` with no horizontal
centring, and `crumb-bar.tsx` pads `px-10` across the full width. On any viewport
wider than ~920px + sidebar the page hugs the left edge and everything right of the
property rail is dead space. The screenshot shows it at ~3440px: content ends around
x≈950, the remaining ~2500px is empty. The skeleton container at `task-page.tsx:356`
has the same defect and must move with it.

**Fix.** One centred content container shared by the crumb bar and the document grid,
so the page keeps a single spine (design law: *one content spine per page*) and the
gutters are symmetric. Widen the cap so the rail is not crammed against the reading
column: document column + `gap-x-9` + 260px rail inside roughly `max-w-[1080px]`,
`mx-auto`. Mobile (`< 700px`) is untouched — already a single column.

The crumb bar must move with the grid; leaving it full-width while the document
centres would break the spine and is not an acceptable outcome.

Files: `packages/web/src/routes/todos/task-page/task-page.tsx` (grid :391, skeleton
:356), `packages/web/src/routes/todos/task-page/crumb-bar.tsx` (its `px-10` becomes
the shared container's).

## 2. The ID should copy when clicked

> "On click of id in the detail page should copy it."

Today the ID is inert: a `<span>` in the desktop crumb (`crumb-bar.tsx:96-101`) and a
plain `<div>` on mobile (`task-page.tsx:441-447`). Copying is buried in the ⋯ menu
(`crumb-bar.tsx:131-137`).

**Fix.** Both ID renderings become buttons that copy the bare ID (`ICI-660`, not the
URL — the link button beside them already does URLs) and show a short visible
confirmation. Keep the ⋯ "Copy ID" item: it is the menu path and removing it was not
asked for.

Files: `crumb-bar.tsx`, `task-page.tsx`.

## 3. The image preview is a dead end

> "on click and open of screenshot preview should allow me to easily click out and
> close the preview or allow me to go back and forth with some arrow buttons or
> keyboard arrows for quick access & preview. it should also allow me to zoom in on
> the images."

`AttachmentLightbox` (`attachment-preview.tsx:104-155`) shows one image with close +
download. Three gaps:

- **Click-out.** `DialogContent` is a `min(1100px, 100vw-96px)` box; a click beside the
  image lands inside that box and does nothing. Only the thin true backdrop closes.
- **No navigation.** `useAttachmentPreview` holds a single `active` attachment with no
  notion of the set it came from.
- **No zoom.**

**Fix.**
- The lightbox surface fills the viewport; a pointer press anywhere that is not the
  image, the toolbar, or an arrow closes it. Esc keeps working; focus returns to the
  tile that opened it.
- `open()` takes the previewable set alongside the attachment. Gallery scope is the
  group you opened from: the item-level image grid (`attachments.tsx`) or that one
  comment's chips (`activity.tsx` `AttachmentChips`) — already separate hook
  instances, so this is honest rather than an invented cross-page gallery.
- ‹ › buttons plus ← → keys move within the set, wrapping at the ends, absent when the
  set has one image. Navigating resets zoom.
- Zoom: a toolbar control and double-click on the image toggle fit ↔ zoomed;
  `+` / `-` / `0` on the keyboard; drag to pan while zoomed; a click on the image while
  zoomed pans rather than closing. Wheel and pinch zoom are **out of scope**.
- Tap targets ≥34px at 390px (Jinn Taste §2), tokens only, both themes.

Files: `attachment-preview.tsx` (hook + lightbox), `attachments.tsx` and `activity.tsx`
(pass their set to `open`).

---

## Acceptance criteria

1. At 1440×900 the detail page's content is horizontally centred: the left gutter and
   the right gutter outside the property rail are within 8px of each other, and the
   crumb bar's first glyph shares its x with the title. Proved by screenshot at
   1440×900 **and** 1920×1080.
2. At 390×844 the detail page layout is unchanged from `main` — single column, no
   centring container, no new horizontal scroll.
3. Clicking the ID in the desktop crumb bar writes exactly `ICI-660` (bare ID, no URL,
   no whitespace) to the clipboard and shows a visible confirmation; clicking the
   mobile ID line does the same. The ⋯ menu's "Copy ID" still works.
4. With ≥2 previewable images in the item-level grid: opening one and pressing `→`
   shows the next; `←` from the first wraps to the last; the ‹ › buttons do the same.
   With exactly one image the arrows are absent.
5. A pointer press on empty space beside the image closes the preview; a pointer press
   on the image itself does not. Esc closes. Focus returns to the tile that opened it.
6. Zoom: the toolbar control and double-click both toggle zoomed state; `+`/`-`/`0`
   change it; while zoomed the image can be dragged; navigating to another image
   returns to fit.
7. A comment's chips form their own gallery — arrows move only within that comment's
   attachments, never into the item-level set.
8. `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build` all green, with every
   existing `task-page.test.tsx` and `task-sections.test.tsx` case still passing.
9. Screenshot matrix on an isolated sandbox (port ≥7778, never 7777/7788): detail page
   and open lightbox, at 1440×900 and 390×844, light and dark.

## Tests

- `packages/web/src/routes/todos/__tests__/task-sections.test.tsx` — lightbox: arrow
  key and button navigation with wrap; arrows absent for a single image; click-outside
  closes and click-on-image does not; zoom toggle and reset-on-navigate; comment
  gallery isolated from the item gallery.
- `packages/web/src/routes/todos/__tests__/task-page.test.tsx` — ID click copies the
  bare ID, desktop and mobile (stub `navigator.clipboard`).
- Layout centring is a browser/screenshot check, not a vitest assertion — jsdom has no
  layout. AC1 and AC2 are proved by measured screenshots.

## Out of scope

- Any gateway or API change. Web-only.
- List and board surfaces, the create dialog, the Attention inbox.
- Wheel/pinch zoom, a cross-section "every image on this Todo" gallery, slideshow,
  rotate, attachment reordering.
- Refactoring `task-page.tsx` beyond the container change.

## Notes

- `PLAN.md` at the repo root is the pipeline's scratch file and currently holds
  ICI-658's plan on `main`; overwriting it is the convention, not a product change.
- Safety: never port 7777 or 7788, never `~/.jinn`; sandbox on ≥7778 via the
  `jinn-sandbox` skill and destroy it even if the run fails.
