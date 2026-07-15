import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/query-keys"
import type { EnginesResponse } from "@/lib/api"

const getEngines = vi.fn()
const setCompanyName = vi.fn()
const setPortalName = vi.fn()
const setOperatorName = vi.fn()
const setAccentColor = vi.fn()
const setLanguage = vi.fn()
const setTheme = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getEngines: (...args: unknown[]) => getEngines(...args),
    completeOnboarding: vi.fn(),
    createSession: vi.fn(),
  },
}))

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({
    settings: {
      companyName: "Acme Labs",
      portalName: "Jinn",
      operatorName: "Operator",
      language: "English",
      accentColor: "#3B82F6",
    },
    setCompanyName,
    setPortalName,
    setOperatorName,
    setAccentColor,
    setLanguage,
  }),
}))

vi.mock("@/routes/providers", () => ({
  useTheme: () => ({ theme: "dark", setTheme }),
}))

import { OnboardingWizard } from "../onboarding-wizard"

const REGISTRY: EnginesResponse = {
  default: "codex",
  engines: {
    codex: {
      name: "codex",
      available: true,
      defaultModel: "gpt-5.5",
      effortMechanism: "codex-config",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
  },
}

function renderWizard() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
      },
    },
  })
  client.setQueryData(queryKeys.engines.all, REGISTRY)

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OnboardingWizard initialVisible />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getEngines.mockReset()
  getEngines.mockRejectedValue(new Error("raw engine fetch should not run"))
  setCompanyName.mockReset()
  setPortalName.mockReset()
  setOperatorName.mockReset()
  setAccentColor.mockReset()
  setLanguage.mockReset()
  setTheme.mockReset()
})

describe("OnboardingWizard model registry", () => {
  it("captures a distinct company name and previews its Todo prefix", async () => {
    renderWizard()

    const companyName = await screen.findByRole("textbox", { name: "Company Name" })
    fireEvent.change(companyName, { target: { value: "IC-IDEV" } })

    expect(screen.getByText(/"IC-IDEV" produces ICI-1, ICI-2/)).toBeTruthy()
    expect(screen.getByText(/cannot be changed after the first Todo/i)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(setCompanyName).toHaveBeenCalledWith("IC-IDEV")
  })

  it("allows an explicit canonical prefix override before allocation", async () => {
    renderWizard()

    fireEvent.change(await screen.findByRole("textbox", { name: "Company Name" }), { target: { value: "Build Sprint Labs" } })
    expect(screen.getByText(/"Build Sprint Labs" produces BSL-1, BSL-2/)).toBeTruthy()

    const override = screen.getByRole("textbox", { name: "Todo Prefix Override" })
    fireEvent.change(override, { target: { value: "JNN" } })
    expect(screen.getByText(/"Build Sprint Labs" produces JNN-1, JNN-2/)).toBeTruthy()

    fireEvent.change(override, { target: { value: "jn" } })
    expect(screen.getByRole("alert").textContent).toMatch(/three uppercase Latin letters/i)
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("does not advance with a company name that cannot produce a prefix", async () => {
    renderWizard()
    fireEvent.change(await screen.findByRole("textbox", { name: "Company Name" }), { target: { value: "AI" } })
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(screen.getByRole("alert").textContent).toMatch(/three Latin letters/i)
  })

  it("uses the shared model registry query cache for engine choices", async () => {
    renderWizard()

    fireEvent.click(await screen.findByRole("button", { name: "Next" }))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))

    expect(await screen.findByText("Codex")).toBeTruthy()
    expect(screen.getByText("GPT-5.5")).toBeTruthy()
    expect(getEngines).not.toHaveBeenCalled()
  })
})
