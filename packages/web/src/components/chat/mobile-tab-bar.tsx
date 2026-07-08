import { Link, useLocation } from "react-router-dom"
import { isNavItemActive } from "@/components/pill-nav"
import { MOBILE_TAB_ITEMS, MORE_NAV_ITEM, OVERFLOW_HREFS } from "@/lib/nav"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// MobileTabBar — GRS-022. The SOLE mobile nav: an icon-only iOS-style bottom tab
// bar carrying the 4 primary destinations (Chat · Todos · Workflows · More).
// Mobile only (lg:hidden); the parent decides when to mount it. Frosted material
// over content with the single 0.5px top hairline iOS tab bars are allowed (the
// one sanctioned exception to "no hairlines at rest").
//
// Icons-only (HIG icons-over-labels): the glyphs are self-explanatory, so the
// bar carries no text. The "you are here" cue is the active tab's --accent tint
// (the sanctioned exception to the desktop rail's "never --accent" rule, scoped
// to THIS component only — the desktop NavRibbon is untouched). Every tab keeps
// an aria-label (no visible text ≠ no accessible name) and a ≥49px tap target so
// a label-free bar stays fully accessible and thumb-friendly.
//
// The More tab stays lit while the operator is on any of its overflow children
// (Org/Cron/Skills/Activity/Limits/Settings), so the bar always shows where you
// are even after a one-tap dive out of the overflow list.
// ---------------------------------------------------------------------------

function isTabActive(href: string, pathname: string): boolean {
  if (href === MORE_NAV_ITEM.href) {
    return (
      pathname === MORE_NAV_ITEM.href ||
      OVERFLOW_HREFS.some((h) => isNavItemActive(h, pathname))
    )
  }
  return isNavItemActive(href, pathname)
}

export function MobileTabBar() {
  const pathname = useLocation().pathname

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 lg:hidden",
        "flex items-stretch",
        "border-t-[0.5px] border-[var(--separator)] bg-[var(--material-thick)]",
        "[backdrop-filter:blur(20px)_saturate(1.3)] [-webkit-backdrop-filter:blur(20px)_saturate(1.3)]",
        "py-1.5 pb-[max(var(--safe-bottom),6px)]",
      )}
    >
      {MOBILE_TAB_ITEMS.map((item) => {
        const isActive = isTabActive(item.href, pathname)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            to={item.href}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              // HIG tab re-tap: tapping the already-active Chat tab scrolls the
              // chat list back to the top (the route is unchanged, so the Link is
              // otherwise a no-op). GRS-023.
              if (isActive && item.href === "/") {
                document
                  .querySelector<HTMLElement>("[data-chat-list-scroll]")
                  ?.scrollTo({ top: 0, behavior: "smooth" })
              }
            }}
            className={cn(
              "min-h-[49px] flex-1 flex items-center justify-center",
              "transition-colors",
              isActive
                ? "text-[var(--accent)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
            )}
          >
            <span className="flex h-9 w-14 items-center justify-center rounded-full">
              <Icon size={25} className="shrink-0" />
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
