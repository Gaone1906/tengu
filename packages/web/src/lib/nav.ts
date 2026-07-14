import {
  MessageSquare,
  Workflow,
  Users,
  Clock,
  ListChecks,
  Activity,
  Gauge,
  Zap,
  Settings,
  MoreHorizontal,
  NotebookPen,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

const BASE_NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/todos", label: "Todos", icon: ListChecks },
  { href: "/workflow", label: "Workflows", icon: Workflow },
  { href: "/org", label: "Organization", icon: Users },
  { href: "/cron", label: "Cron", icon: Clock },
  { href: "/limits", label: "Limits", icon: Gauge },
  { href: "/logs", label: "Activity", icon: Activity },
  { href: "/skills", label: "Skills", icon: Zap },
  { href: "/settings", label: "Settings", icon: Settings },
]

const NOTES_NAV_ITEM: NavItem = { href: "/notes", label: "Notes", icon: NotebookPen }

// GRS-022 — the mobile bottom tab bar is the SOLE mobile nav (the top-left
// hamburger is gone). HIG caps a tab bar at ~4–5 self-explanatory items, so we
// carry the 4 primary destinations and hand everything else to a "More" tab that
// opens the grouped overflow screen (/more). Chat + Todos + Workflows are the
// day-to-day phone surfaces; Organization/Cron/Skills/Activity/Limits/Settings
// live one tap deep under More. The bar is icon-only (see mobile-tab-bar.tsx).

// The "More" tab is not a NAV_ITEMS destination — it's the overflow entry point.
export const MORE_NAV_ITEM: NavItem = { href: "/more", label: "More", icon: MoreHorizontal }

export function navigationFor(notesEnabled: boolean): {
  items: NavItem[]
  mobileItems: NavItem[]
  overflowItems: NavItem[]
  overflowHrefs: string[]
} {
  const items = notesEnabled
    ? [...BASE_NAV_ITEMS.slice(0, 2), NOTES_NAV_ITEM, ...BASE_NAV_ITEMS.slice(2)]
    : BASE_NAV_ITEMS
  const primaryHrefs = notesEnabled ? ["/", "/todos", "/notes", "/workflow"] : ["/", "/todos", "/workflow"]
  const mobileItems = [
    ...primaryHrefs.map((href) => items.find((item) => item.href === href)!),
    MORE_NAV_ITEM,
  ]
  const overflowItems = items.filter((item) => !primaryHrefs.includes(item.href))
  return { items, mobileItems, overflowItems, overflowHrefs: overflowItems.map((item) => item.href) }
}

// Safe defaults keep a newly installed or temporarily disabled feature out of
// every static consumer before the runtime feature query completes.
export const NAV_ITEMS = navigationFor(false).items
export const MOBILE_TAB_ITEMS = navigationFor(false).mobileItems

// Destinations that live INSIDE the More overflow screen (everything not a
// primary tab). Derived from NAV_ITEMS so the overflow order always mirrors
// the shared nav order — no second hardcoded list. Used both to build the More
// screen and to keep the More tab lit while the operator is on any of its
// children.
export const OVERFLOW_ITEMS = navigationFor(false).overflowItems
export const OVERFLOW_HREFS = navigationFor(false).overflowHrefs
