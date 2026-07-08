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
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/workflow", label: "Workflows", icon: Workflow },
  { href: "/org", label: "Organization", icon: Users },
  { href: "/todos", label: "Todos", icon: ListChecks },
  { href: "/cron", label: "Cron", icon: Clock },
  { href: "/limits", label: "Limits", icon: Gauge },
  { href: "/logs", label: "Activity", icon: Activity },
  { href: "/skills", label: "Skills", icon: Zap },
  { href: "/settings", label: "Settings", icon: Settings },
]

// GRS-022 — the mobile bottom tab bar is the SOLE mobile nav (the top-left
// hamburger is gone). HIG caps a tab bar at ~4–5 self-explanatory items, so we
// carry the 4 primary destinations and hand everything else to a "More" tab that
// opens the grouped overflow screen (/more). Chat + Todos + Workflows are the
// day-to-day phone surfaces; Organization/Cron/Skills/Activity/Limits/Settings
// live one tap deep under More. The bar is icon-only (see mobile-tab-bar.tsx).

// The "More" tab is not a NAV_ITEMS destination — it's the overflow entry point.
export const MORE_NAV_ITEM: NavItem = { href: "/more", label: "More", icon: MoreHorizontal }

const MOBILE_TAB_PRIMARY_HREFS = ["/", "/todos", "/workflow"] as const
export const MOBILE_TAB_ITEMS: NavItem[] = [
  ...MOBILE_TAB_PRIMARY_HREFS.map((href) => NAV_ITEMS.find((item) => item.href === href)!),
  MORE_NAV_ITEM,
]

// Destinations that live INSIDE the More overflow screen (everything not a
// primary tab and not Chat). Used both to build the More screen and to keep the
// More tab lit while the operator is on any of its children.
export const OVERFLOW_HREFS = ["/org", "/cron", "/skills", "/logs", "/limits", "/settings"] as const
export const OVERFLOW_ITEMS: NavItem[] = OVERFLOW_HREFS.map(
  (href) => NAV_ITEMS.find((item) => item.href === href)!,
)
