import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/query-keys"

const getOrg = vi.fn()
const getSkills = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getOrg: (...args: unknown[]) => getOrg(...args),
    getSkills: (...args: unknown[]) => getSkills(...args),
  },
}))

vi.mock("@/hooks/use-stt", () => ({
  useStt: () => ({
    state: "idle",
    error: null,
    analyser: null,
    languages: ["en"],
    selectedLanguage: "en",
    downloadProgress: null,
    cycleLanguage: vi.fn(),
    handleMicClick: vi.fn(),
    stopRecording: vi.fn(),
    dismissError: vi.fn(),
    startDownload: vi.fn(),
    dismissDownload: vi.fn(),
  }),
}))

vi.mock("@/components/stt/whisper-download-modal", () => ({
  WhisperDownloadModal: () => null,
}))

import { ChatInput } from "../chat-input"

function renderWithCachedQueries() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
      },
    },
  })
  client.setQueryData(queryKeys.org.all, {
    employees: [
      {
        name: "a-lead",
        displayName: "A Lead",
        department: "Operations",
        rank: "lead",
        engine: "claude",
      },
    ],
  })
  client.setQueryData(queryKeys.skills.all, [
    { name: "custom", description: "Custom skill" },
    { name: "sync", description: "Sync employee context" },
  ])

  return render(
    <QueryClientProvider client={client}>
      <ChatInput
        disabled={false}
        loading={false}
        onSend={vi.fn()}
        onNewSession={vi.fn()}
        onStatusRequest={vi.fn()}
        events={[]}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  getOrg.mockReset()
  getSkills.mockReset()
  getOrg.mockRejectedValue(new Error("raw org fetch should not run"))
  getSkills.mockRejectedValue(new Error("raw skills fetch should not run"))
})

describe("ChatInput query-backed menus", () => {
  it("populates @mentions and slash commands from the shared query cache", async () => {
    renderWithCachedQueries()

    const input = screen.getByPlaceholderText("Type a message...")
    fireEvent.change(input, { target: { value: "@a" } })
    expect(await screen.findByText("@a-lead")).toBeTruthy()

    fireEvent.change(input, { target: { value: "/cu" } })
    expect(await screen.findByText("/custom")).toBeTruthy()

    expect(getOrg).not.toHaveBeenCalled()
    expect(getSkills).not.toHaveBeenCalled()
  })
})
