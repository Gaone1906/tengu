import { lazy, Suspense, useEffect, useState } from "react"
import { NavRibbon } from "./pill-nav"
import { MobileTabBar } from "./chat/mobile-tab-bar"
import { cn } from "@/lib/utils"
import { useOnboarding } from "@/hooks/use-onboarding"
import { runAfterLoad, useLoadDeferredMount } from "@/hooks/use-idle-mount"

const loadGlobalSearch = () => import("./global-search")
const loadLiveStreamWidget = () => import("./live-stream-widget")
const loadOnboardingWizard = () => import("./onboarding-wizard")

const GlobalSearch = lazy(() => loadGlobalSearch().then(m => ({ default: m.GlobalSearch })))
const LiveStreamWidget = lazy(() => loadLiveStreamWidget().then(m => ({ default: m.LiveStreamWidget })))
const OnboardingWizard = lazy(() => loadOnboardingWizard().then(m => ({ default: m.OnboardingWizard })))

function isCommandPaletteShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"
}

function DeferredGlobalSearch() {
  const [mounted, setMounted] = useState(false)
  const [initialOpen, setInitialOpen] = useState(false)

  // Warm the Cmd-K chunk, but only well after load so the fetch stays out of
  // the first-paint / pre-interaction waterfall. A key press before this fires
  // still opens instantly — the keydown handler mounts (and imports) on demand.
  useEffect(() => runAfterLoad(() => {
    void loadGlobalSearch()
  }), [])

  useEffect(() => {
    if (mounted) return
    function handleKeyDown(e: KeyboardEvent) {
      if (!isCommandPaletteShortcut(e)) return
      e.preventDefault()
      setInitialOpen(true)
      setMounted(true)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [mounted])

  if (!mounted) return null

  return (
    <Suspense fallback={null}>
      <GlobalSearch initialOpen={initialOpen} />
    </Suspense>
  )
}

function DeferredLiveStreamWidget() {
  // Non-critical shell widget — mount after load so its chunk never lands in
  // the measured first-paint / pre-interaction waterfall.
  const mounted = useLoadDeferredMount()
  if (!mounted) return null
  return (
    <Suspense fallback={null}>
      <LiveStreamWidget />
    </Suspense>
  )
}

function DeferredOnboardingWizard() {
  // Consumes the SAME shared onboarding query as SettingsProvider, so a clean
  // load only fetches /api/onboarding once. The localStorage short-circuit keeps
  // the query disabled for already-onboarded users (no request at all).
  const onboardedLocally =
    typeof window !== "undefined" && !!localStorage.getItem("jinn-onboarded")
  const { data, isError } = useOnboarding({ enabled: !onboardedLocally })

  useEffect(() => {
    if (data?.onboarded && typeof window !== "undefined") {
      localStorage.setItem("jinn-onboarded", "true")
    }
  }, [data?.onboarded])

  if (onboardedLocally) return null
  // Fall back to "needed" on error so a failed fetch still surfaces onboarding
  // (matches the previous best-effort behavior).
  const needed = data ? data.needed : isError
  if (!needed) return null

  return (
    <Suspense fallback={null}>
      <OnboardingWizard initialVisible />
    </Suspense>
  )
}

export function ToolbarActions({ children }: { children?: React.ReactNode }) {
  return (
    <div className="hidden items-center gap-2 lg:flex">
      {children}
    </div>
  )
}

/**
 * App shell. Desktop nav is the global NavRibbon (the same polished icon rail
 * the chat route uses) mounted as a left column — no list to fold, so its top
 * slot is the brand mark. The active rail icon is the "you are here" cue, so
 * there is no persistent title pill; pages that want a heading render their own
 * inline header (e.g. Todos).
 *
 * Mobile nav is the MobileTabBar ALONE (GRS-022). The old top-left
 * hamburger+title pill was removed: the bottom tab bar carries all cross-route
 * navigation (with a "More" tab for the overflow), and each page renders its own
 * inline large-title header + top-right actions in content — no global mobile
 * chrome bar. `chromeless` routes (chat) draw their own rail + pills.
 *
 * `headerActions` is retained on the signature for callers, but no page supplies
 * one today — pages own their actions inline via ToolbarActions.
 */
export function PageLayout({ children, headerActions: _headerActions, chromeless }: { children: React.ReactNode; headerActions?: React.ReactNode; chromeless?: boolean }) {
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <DeferredGlobalSearch />
      {/* Global desktop nav rail (hidden < lg from inside NavRibbon). Sibling of
          <main> so its per-icon label pills can escape rightward over content. */}
      {!chromeless && <NavRibbon />}
      <main className="relative flex flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "flex-1 overflow-hidden",
            // Notch clearance only (mobile) — no global top chrome to clear now
            // that the hamburger pill is gone; pages own their inline headers.
            !chromeless && "pt-[var(--safe-top)] lg:pt-0",
            // Clear the mobile bottom tab bar (mobile only; the bar is the
            // persistent cross-route nav). Desktop has no bar.
            !chromeless && "pb-[calc(49px+var(--safe-bottom))] lg:pb-0",
          )}
        >
          {children}
        </div>
        {/* Persistent mobile nav — same curated tab bar across every standard
            page so nav never disappears (Chat draws its own on the list screen). */}
        {!chromeless && <MobileTabBar />}
      </main>
      <DeferredLiveStreamWidget />
      <DeferredOnboardingWizard />
    </div>
  )
}
