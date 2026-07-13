import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

let sttState = "idle"
const handleMicClick = vi.fn()
const cancelRecording = vi.fn()
const orgData = { employees: [] }
const skillsData: unknown[] = []
const refetchSkills = vi.fn()

vi.mock("@/hooks/use-employees", () => ({
  useOrg: () => ({ data: orgData }),
}))

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({ data: skillsData, refetch: refetchSkills }),
}))

vi.mock("@/hooks/use-stt", () => ({
  useStt: () => ({
    state: sttState,
    available: true,
    error: null,
    analyser: null,
    languages: ["en"],
    selectedLanguage: "en",
    downloadProgress: null,
    cycleLanguage: vi.fn(),
    handleMicClick,
    startRecording: vi.fn(),
    stopRecording: vi.fn(async () => null),
    cancelRecording,
    startDownload: vi.fn(),
    dismissDownload: vi.fn(),
    dismissError: vi.fn(),
  }),
}))

import { ChatInput } from "../chat-input"

function renderInput() {
  return render(
    <ChatInput
      disabled={false}
      loading={false}
      onSend={vi.fn()}
      onNewSession={vi.fn()}
      onStatusRequest={vi.fn()}
      events={[]}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  sttState = "idle"
})

describe("ChatInput microphone state", () => {
  it("renders an honest busy starting state without claiming to record", () => {
    sttState = "starting"
    renderInput()

    const button = screen.getByRole("button", { name: "Starting voice input…" })
    expect(button.getAttribute("aria-busy")).toBe("true")
    expect(button.getAttribute("data-state")).toBe("starting")
    expect(button.getAttribute("title")).toMatch(/starting/i)
    expect(button.querySelector("canvas")).toBeNull()
    expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull()
  })

  it("cancels a pending start when the microphone is pressed again", () => {
    sttState = "starting"
    renderInput()

    fireEvent.pointerDown(screen.getByRole("button", { name: "Starting voice input…" }), {
      pointerId: 1,
    })

    expect(cancelRecording).toHaveBeenCalledTimes(1)
    expect(handleMicClick).not.toHaveBeenCalled()
  })

  it("treats pointer cancellation as cancellation instead of a completed tap", () => {
    renderInput()
    const button = screen.getByRole("button", { name: "Voice input" })

    fireEvent.pointerDown(button, { pointerId: 1 })
    fireEvent.pointerCancel(button, { pointerId: 1 })

    expect(handleMicClick).toHaveBeenCalledTimes(1)
    expect(cancelRecording).toHaveBeenCalledTimes(1)
  })
})
