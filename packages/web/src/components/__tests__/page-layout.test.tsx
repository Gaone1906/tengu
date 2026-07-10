import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

type IdleCallback = (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void

let idleCallbacks: IdleCallback[] = []

function flushIdleCallbacks() {
  const callbacks = idleCallbacks
  idleCallbacks = []
  for (const callback of callbacks) {
    callback({ didTimeout: false, timeRemaining: () => 50 })
  }
}

function renderLayout() {
  return render(
    <PageLayout chromeless>
      <div>Page content</div>
    </PageLayout>,
  )
}

beforeEach(() => {
  localStorage.clear()
  getOnboarding.mockReset()
  getOnboarding.mockResolvedValue({ onboarded: true, needed: false })
  idleCallbacks = []
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: vi.fn((callback: IdleCallback) => {
      idleCallbacks.push(callback)
      return idleCallbacks.length
    }),
  })
  Object.defineProperty(window, "cancelIdleCallback", {
    configurable: true,
    value: vi.fn(),
  })
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

  it("mounts the live stream widget on idle", async () => {
    localStorage.setItem("jinn-onboarded", "true")
    renderLayout()

    expect(screen.queryByTestId("live-stream-widget")).toBeNull()

    await act(async () => {
      flushIdleCallbacks()
    })

    expect(await screen.findByTestId("live-stream-widget")).toBeTruthy()
  })

  it("imports onboarding only when the gateway says onboarding is needed", async () => {
    getOnboarding.mockResolvedValue({ onboarded: false, needed: true })

    renderLayout()

    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1))
    const wizard = await screen.findByTestId("onboarding-wizard")
    expect(wizard.getAttribute("data-initial-visible")).toBe("true")
  })

  it("does not import onboarding when the gateway is already onboarded", async () => {
    getOnboarding.mockResolvedValue({ onboarded: true, needed: false })

    renderLayout()

    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("onboarding-wizard")).toBeNull()
    expect(localStorage.getItem("jinn-onboarded")).toBe("true")
  })
})
