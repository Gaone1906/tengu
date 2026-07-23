import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check } from "lucide-react"

/* Todos v2 slice 6 — the picker shells (design-doc §7.3, polish laws 1–4, 22).
 *
 * ONE picker-content component per property, rendered in TWO shells:
 *  - Desktop: a popover that SUPERIMPOSES its anchor row, NSMenu-style — the
 *    current value's option row sits exactly over the anchor, glyph column on
 *    glyph column (law 1: top −7px − currentIndex·36; left −6px against the
 *    row's −10px wash bleed; width 314 ≥ the anchor's washed width, law 2).
 *    Short on space below → flip upward, keeping the selected row over the
 *    anchor when the viewport allows (law 3).
 *  - Mobile: a bottom sheet rising from the edge (law 4 — sheets never
 *    superimpose): grabber, sheet title, 44px rows, safe-area padding,
 *    material-thick, top radius 18. One sheet at a time.
 *
 * Material: --material-thick + blur 20 + --shadow-overlay; its 0.5px ring is
 * the only border (law 22). */

const ROW_H = 36

/** Popover keyboard contract (§7.3): ↑↓ moves among focusable option rows
 *  (disabled rows are focusable so screen readers hear the reason — skipped by
 *  Enter, which each row enforces via aria-disabled); Esc closes and returns
 *  focus to the anchor row. */
function usePickerKeyboard(containerRef: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
      const rows = [...container.querySelectorAll<HTMLElement>("[data-picker-row]")]
      if (rows.length === 0) return
      event.preventDefault()
      const index = rows.indexOf(document.activeElement as HTMLElement)
      const next = event.key === "ArrowDown"
        ? rows[Math.min(rows.length - 1, index + 1)] ?? rows[0]
        : rows[Math.max(0, index - 1)] ?? rows[rows.length - 1]
      next.focus()
    }
    container.addEventListener("keydown", onKey)
    return () => container.removeEventListener("keydown", onKey)
  }, [containerRef, onClose])
}

function useDismissOutside(containerRef: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const container = containerRef.current
      if (container && !container.contains(event.target as Node)) onClose()
    }
    // Capture phase so a click that also toggles the anchor row still closes.
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [containerRef, onClose])
}

export function PickerPopover({
  onClose,
  currentIndex = 0,
  autoFocusFirst = true,
  children,
  testId,
  label,
}: {
  onClose: () => void
  /** Index of the current value's option row — the one that superimposes the
   *  anchor (law 1). Search-led pickers pass 0: the shell's top aligns over
   *  the anchor instead. */
  currentIndex?: number
  autoFocusFirst?: boolean
  children: React.ReactNode
  testId?: string
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  usePickerKeyboard(ref, onClose)
  useDismissOutside(ref, onClose)

  // Flip/clamp: keep the menu on screen; prefer keeping the selected row over
  // the anchor, give that up only when the viewport is genuinely short.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.height === 0) return // unmeasured layout (jsdom) — keep the law's offsets
    const overflowBottom = rect.bottom - (window.innerHeight - 8)
    const overflowTop = 8 - rect.top
    if (overflowBottom > 0) setShift(-Math.min(overflowBottom, Math.max(0, rect.top - 8)))
    else if (overflowTop > 0) setShift(overflowTop)
  }, [])

  useEffect(() => {
    if (!autoFocusFirst) return
    const rows = ref.current?.querySelectorAll<HTMLElement>("[data-picker-row]")
    const target = rows?.[Math.min(currentIndex, (rows?.length ?? 1) - 1)] ?? rows?.[0]
    target?.focus()
  }, [autoFocusFirst, currentIndex])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-testid={testId}
      className="absolute z-30 w-[314px] cursor-default rounded-[14px] p-1.5 backdrop-blur-[20px]"
      style={{
        top: -7 - currentIndex * ROW_H + shift,
        left: -6,
        background: "var(--material-thick)",
        boxShadow: "var(--shadow-overlay)",
      }}
    >
      {children}
    </div>
  )
}

export function PickerSheet({
  title,
  onClose,
  children,
  testId,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  testId?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  usePickerKeyboard(ref, onClose)
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-[var(--scrim,rgba(0,0,0,0.35))]" />
      <div
        ref={ref}
        data-testid={testId}
        className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-[18px] p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-[20px]"
        style={{ background: "var(--material-thick)", boxShadow: "var(--shadow-overlay)" }}
      >
        <div className="flex justify-center pb-1.5 pt-0.5">
          <span aria-hidden className="h-[5px] w-9 rounded-full bg-[var(--fill-primary)]" />
        </div>
        <div className="px-2.5 pb-2 text-[15px] font-semibold text-[var(--text-primary)]">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** One option row (36px desktop / 44px in sheets via min-h override). */
export function PickerRow({
  glyph,
  label,
  sub,
  checked,
  disabled,
  reason,
  onSelect,
  testId,
  trailing,
  sheet,
}: {
  glyph?: React.ReactNode
  label: React.ReactNode
  /** Inline second line (the gated reason lives here at 11px). */
  sub?: React.ReactNode
  checked?: boolean
  disabled?: boolean
  reason?: string
  onSelect?: () => void
  testId?: string
  trailing?: React.ReactNode
  sheet?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-picker-row
      data-testid={testId}
      aria-disabled={disabled || undefined}
      aria-description={disabled && reason ? reason : undefined}
      onClick={() => {
        if (disabled) return
        onSelect?.()
      }}
      className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[5px] text-left text-[13.5px] font-medium text-[var(--text-primary)] outline-none focus-visible:bg-[var(--fill-tertiary)] ${
        sheet ? "min-h-11" : "min-h-9"
      } ${disabled ? "cursor-default opacity-50" : "hover:bg-[var(--fill-tertiary)]"}`}
    >
      {glyph}
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate">{label}</span>
        {(sub ?? (disabled && reason)) && (
          <span className="text-[11px] font-normal text-[var(--text-quaternary)]">{sub ?? reason}</span>
        )}
      </span>
      {checked && <Check size={13} strokeWidth={2.6} aria-hidden className="ml-auto flex-none text-[var(--accent)]" />}
      {!checked && trailing && <span className="ml-auto flex-none">{trailing}</span>}
    </button>
  )
}

/** The quiet footnote line that can close a menu (§7.3). */
export function PickerNote({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1 pt-[7px] text-[10.5px] leading-snug text-[var(--text-quaternary)]">{children}</div>
}
