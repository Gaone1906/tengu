import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getOnboarding = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getOnboarding: (...args: unknown[]) => getOnboarding(...args),
  },
}))

vi.mock("../global-search", () => ({
  GlobalSearch: ({ initialOpen }: { initialOpen?: boolean }) => (
    <div data-testid="global-search" data-initial-open={String(Boolean(initialOpen))} />
  ),
}))

vi.mock("../live-stream-widget", () => ({
  LiveStreamWidget: () => <div data-testid="live-stream-widget" />,
}))

vi.mock("../onboarding-wizard", () => ({
  OnboardingWizard: ({ initialVisible }: { initialVisible?: boolean }) => (
    <div data-testid="onboarding-wizard" data-initial-visible={String(Boolean(initialVisible))} />
  ),
}))

import { PageLayout } from "../page-layout"

function renderLayout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <PageLayout chromeless>
        <div>Page content</div>
      </PageLayout>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, "", "/")
  getOnboarding.mockReset()
  getOnboarding.mockResolvedValue({ onboarded: true, needed: false })
})

describe("PageLayout deferred shell widgets", () => {
  it("does not mount search, live stream, or onboarding during the initial render", () => {
    localStorage.setItem("jinn-onboarded", "true")

    renderLayout()

    expect(screen.getByText("Page content")).toBeTruthy()
    expect(screen.queryByTestId("global-search")).toBeNull()
    expect(screen.queryByTestId("live-stream-widget")).toBeNull()
    expect(screen.queryByTestId("onboarding-wizard")).toBeNull()
    expect(getOnboarding).not.toHaveBeenCalled()
  })

  it("mounts the command palette opened on the first command-k press", async () => {
    localStorage.setItem("jinn-onboarded", "true")
    renderLayout()

    fireEvent.keyDown(window, { key: "k", metaKey: true })

    const search = await screen.findByTestId("global-search")
    expect(search.getAttribute("data-initial-open")).toBe("true")
  })

  it("mounts the live stream widget after the page finishes loading", async () => {
    vi.useFakeTimers()
    try {
      localStorage.setItem("jinn-onboarded", "true")
      renderLayout()

      expect(screen.queryByTestId("live-stream-widget")).toBeNull()

      // jsdom reports readyState "complete", so runAfterLoad schedules the
      // deferred timer immediately; dispatching load also covers the
      // not-yet-loaded branch. The async advance flushes the lazy Suspense
      // import that resolves after the widget mounts.
      await act(async () => {
        window.dispatchEvent(new Event("load"))
        await vi.advanceTimersByTimeAsync(2600)
      })

      expect(screen.getByTestId("live-stream-widget")).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("imports onboarding only when the gateway says onboarding is needed", async () => {
    getOnboarding.mockResolvedValue({ onboarded: false, needed: true })

    renderLayout()

    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1))
    const wizard = await screen.findByTestId("onboarding-wizard")
    expect(wizard.getAttribute("data-initial-visible")).toBe("true")
  })

  it("honors a fresh-workspace onboarding launch even if this origin has stale local state", async () => {
    localStorage.setItem("jinn-onboarded", "true")
    window.history.replaceState(null, "", "/?onboarding=1")
    getOnboarding.mockResolvedValue({ onboarded: false, needed: true })

    renderLayout()

    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId("onboarding-wizard")).toBeTruthy()
  })

  it("does not import onboarding when the gateway is already onboarded", async () => {
    getOnboarding.mockResolvedValue({ onboarded: true, needed: false })

    renderLayout()

    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("onboarding-wizard")).toBeNull()
    await waitFor(() => expect(localStorage.getItem("jinn-onboarded")).toBe("true"))
  })
})
