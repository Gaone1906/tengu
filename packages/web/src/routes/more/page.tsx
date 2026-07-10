import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ChevronRight, Sun, Moon, Palette, ArrowLeftRight, type LucideIcon } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { useTheme } from "@/routes/providers"
import { THEMES, type ThemeId } from "@/lib/themes"
import { NAV_ITEMS, OVERFLOW_ITEMS, type NavItem } from "@/lib/nav"
import { cn } from "@/lib/utils"

// GRS-022 — the mobile "More" overflow. The 4th bottom-tab slot opens this
// grouped iOS-Settings-style screen holding every destination that isn't a
// primary tab. Reachable at /more (deep-linkable); the mobile tab bar keeps its
// More icon lit while any of these children is open. Desktop still reaches all
// of these from the NavRibbon rail — this screen is the phone's overflow home.

function itemFor(href: string): NavItem {
  return NAV_ITEMS.find((n) => n.href === href)!
}

// Per-row icon tint — a filled rounded square (iOS Settings vibe). Theme-aware
// via the shared system tokens; the accent square uses the on-accent contrast
// token for its glyph, the colored squares use white.
const TINT: Record<string, { bg: string; fg: string }> = {
  "/org": { bg: "var(--system-blue)", fg: "#fff" },
  "/cron": { bg: "var(--system-orange)", fg: "#fff" },
  "/skills": { bg: "var(--accent)", fg: "var(--accent-contrast)" },
  "/logs": { bg: "var(--system-green)", fg: "#fff" },
  "/limits": { bg: "var(--system-blue)", fg: "#fff" },
  "/settings": { bg: "var(--text-tertiary)", fg: "var(--bg-secondary)" },
}

// The overflow links derive from the SAME ordered nav list as the desktop and
// chat rails (OVERFLOW_ITEMS mirrors NAV_ITEMS order) — no page-local order.
// Settings is held out: it lives in the App group below with Appearance.
const OVERFLOW_LINKS: NavItem[] = OVERFLOW_ITEMS.filter((item) => item.href !== "/settings")

function RowIcon({ Icon, href }: { Icon: LucideIcon; href: string }) {
  const tint = TINT[href] ?? { bg: "var(--text-tertiary)", fg: "#fff" }
  return (
    <span
      className="flex size-[29px] shrink-0 items-center justify-center rounded-[8px]"
      style={{ background: tint.bg, color: tint.fg }}
    >
      <Icon size={17} className="shrink-0" aria-hidden />
    </span>
  )
}

function LinkRow({ item, first }: { item: NavItem; first: boolean }) {
  const Icon = item.icon
  return (
    <Link
      to={item.href}
      className={cn(
        "flex h-[52px] items-center gap-3 px-3.5 text-[var(--text-primary)] transition-colors active:bg-[var(--fill-secondary)]",
        !first && "border-t-[0.5px] border-[var(--separator)]",
      )}
    >
      <RowIcon Icon={Icon} href={item.href} />
      <span className="flex-1 text-[length:var(--text-body)] font-[var(--weight-medium)] tracking-[-0.01em]">
        {item.label}
      </span>
      <ChevronRight size={18} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden />
    </Link>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]">
      {children}
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-[7px] pt-4 text-[length:var(--text-caption1)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
      {children}
    </div>
  )
}

function ThemeIcon({ theme }: { theme: ThemeId }) {
  if (theme === "light") return <Sun size={17} aria-hidden />
  if (theme === "dark") return <Moon size={17} aria-hidden />
  return <Palette size={17} aria-hidden />
}

/** Appearance row — an inline Light/Dark/System segmented control wired to the
 *  live theme. Re-homes the theme cycle that used to live in the nav footer. */
function AppearanceRow() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="flex h-[52px] items-center gap-3 border-t-[0.5px] border-[var(--separator)] px-3.5">
      <span
        className="flex size-[29px] shrink-0 items-center justify-center rounded-[8px]"
        style={{ background: "var(--text-tertiary)", color: "var(--bg-secondary)" }}
      >
        <ThemeIcon theme={theme} />
      </span>
      <span className="flex-1 text-[length:var(--text-body)] font-[var(--weight-medium)] tracking-[-0.01em] text-[var(--text-primary)]">
        Appearance
      </span>
      <div className="flex items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5" role="group" aria-label="Appearance">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTheme(t.id)}
            aria-pressed={theme === t.id}
            className={cn(
              "rounded-full px-3 py-1 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-all",
              theme === t.id
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)] shadow-[var(--shadow-subtle)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

interface InstanceInfo {
  name: string
  port: number
  running: boolean
  current: boolean
}

/** Instance switcher — re-homed from the retired nav footer. Only rendered when
 *  more than one instance is registered, so a single-instance setup stays clean. */
function InstancesGroup() {
  const [instances, setInstances] = useState<InstanceInfo[]>([])
  useEffect(() => {
    fetch("/api/instances")
      .then((r) => r.json())
      .then((d) => setInstances(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [])

  if (instances.length <= 1) return null

  return (
    <>
      <GroupLabel>Instances</GroupLabel>
      <Card>
        {instances.map((inst, i) => (
          <button
            key={inst.port}
            type="button"
            onClick={() => {
              if (!inst.current && inst.running) {
                window.location.href = `http://localhost:${inst.port}/chat`
              }
            }}
            disabled={inst.current || !inst.running}
            className={cn(
              "flex h-[52px] w-full items-center gap-3 px-3.5 text-left transition-colors",
              i > 0 && "border-t-[0.5px] border-[var(--separator)]",
              inst.current || !inst.running ? "cursor-default" : "active:bg-[var(--fill-secondary)]",
            )}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: inst.running ? "var(--system-green)" : "var(--text-quaternary)" }}
              aria-hidden
            />
            <span
              className={cn(
                "flex-1 truncate text-[length:var(--text-body)] tracking-[-0.01em]",
                inst.current
                  ? "font-[var(--weight-semibold)] text-[var(--text-primary)]"
                  : inst.running
                    ? "text-[var(--text-secondary)]"
                    : "text-[var(--text-quaternary)]",
              )}
            >
              {inst.name}
            </span>
            {inst.current && (
              <span className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Current</span>
            )}
          </button>
        ))}
      </Card>
    </>
  )
}

export default function MorePage() {
  useBreadcrumbs([{ label: "More" }])

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[560px] px-4 pb-20 pt-6 md:pt-11">
          <h1 className="px-1 font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
            More
          </h1>

          <div className="mt-5">
            <Card>
              {OVERFLOW_LINKS.map((item, i) => (
                <LinkRow key={item.href} item={item} first={i === 0} />
              ))}
            </Card>
          </div>

          <GroupLabel>App</GroupLabel>
          <Card>
            <LinkRow item={itemFor("/settings")} first />
            <AppearanceRow />
          </Card>

          <InstancesGroup />
        </div>
      </div>
    </PageLayout>
  )
}
