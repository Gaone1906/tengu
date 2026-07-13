import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const stt = vi.hoisted(() => ({
  state: "idle",
  available: true,
  downloadProgress: null as number | null,
  analyser: null,
  languages: ["en"],
  selectedLanguage: "en",
  error: null as string | null,
  cycleLanguage: vi.fn(),
  handleMicClick: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn<() => Promise<string | null>>(),
  cancelRecording: vi.fn(),
  startDownload: vi.fn(),
  dismissDownload: vi.fn(),
  dismissError: vi.fn(),
}))

const gatewayEvents = vi.hoisted(() => ([
  { event: "stt:download:progress", payload: { progress: 0.42 } },
]))
const useSttMock = vi.hoisted(() => vi.fn(() => stt))

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({ events: gatewayEvents }),
}))
vi.mock("@/hooks/use-stt", () => ({ useStt: useSttMock }))

import { NoteMic } from "../note-mic"

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  stt.state = "idle"
  stt.languages = ["en"]
  stt.error = null
  stt.stopRecording.mockResolvedValue("dictated words")
})

afterEach(() => vi.useRealTimers())

describe("NoteMic", () => {
  it("passes GatewayProvider STT events into useStt", () => {
    const onTranscript = vi.fn()
    render(<NoteMic onTranscript={onTranscript} />)

    expect(useSttMock).toHaveBeenCalledWith(gatewayEvents, onTranscript)
  })

  it("renders a 52px bottom-centered control with press feedback and no send action", () => {
    render(<NoteMic onTranscript={vi.fn()} />)
    const button = screen.getByRole("button", { name: "Voice input" })
    expect(button.className).toContain("size-[52px]")
    expect(button.className).toContain("active:scale-[0.96]")
    expect(button.closest("[data-note-mic-anchor]")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull()
  })

  it("expands into a recording waveform pill and exposes language choice only when needed", () => {
    stt.state = "recording"
    stt.languages = ["en", "bg"]
    render(<NoteMic onTranscript={vi.fn()} />)

    const button = screen.getByRole("button", { name: "Stop recording" })
    expect(button.className).toContain("w-[136px]")
    expect(screen.getByRole("button", { name: /transcription language/i })).toBeTruthy()
  })

  it("uses quick tap to toggle and hold release to insert the returned transcript", async () => {
    const onTranscript = vi.fn()
    const { rerender } = render(<NoteMic onTranscript={onTranscript} />)
    const idle = screen.getByRole("button", { name: "Voice input" })

    fireEvent.pointerDown(idle, { pointerId: 1 })
    fireEvent.pointerUp(idle, { pointerId: 1 })
    expect(stt.handleMicClick).toHaveBeenCalledTimes(1)
    expect(stt.stopRecording).not.toHaveBeenCalled()

    stt.state = "recording"
    rerender(<NoteMic onTranscript={onTranscript} />)
    const recording = screen.getByRole("button", { name: "Stop recording" })
    fireEvent.pointerDown(recording, { pointerId: 2 })
    await act(async () => vi.advanceTimersByTimeAsync(400))
    fireEvent.pointerUp(recording, { pointerId: 2 })
    await act(async () => {})

    expect(stt.stopRecording).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledWith("dictated words")
  })
})
