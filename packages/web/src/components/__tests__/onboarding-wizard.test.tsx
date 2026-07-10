import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/query-keys"
import type { EnginesResponse } from "@/lib/api"

const getEngines = vi.fn()
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
      portalName: "Jinn",
      operatorName: "Operator",
      language: "English",
      accentColor: "#3B82F6",
    },
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
  setPortalName.mockReset()
  setOperatorName.mockReset()
  setAccentColor.mockReset()
  setLanguage.mockReset()
  setTheme.mockReset()
})

describe("OnboardingWizard model registry", () => {
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
