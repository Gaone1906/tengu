import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { VideoPlayer } from "../video-player"

describe("VideoPlayer", () => {
  it("shows a poster play affordance without fetching video bytes before play", () => {
    render(<VideoPlayer src="/api/files/clip" name="clip.mp4" />)

    expect(screen.getByAltText("clip.mp4 preview").getAttribute("src")).toBe("/api/files/clip?poster=1")
    expect(screen.queryByTestId("video-player-element")).toBeNull()
    expect(screen.getByLabelText("Play clip.mp4")).toBeTruthy()
    expect((screen.getByLabelText("Download clip.mp4") as HTMLAnchorElement).getAttribute("href"))
      .toBe("/api/files/clip?download=1")
  })

  it("shows an optimistic local video preview with a play affordance", () => {
    render(<VideoPlayer src="blob:http://jinn.local/clip" name="clip.mp4" />)

    const preview = screen.getByTestId("video-player-preview") as HTMLVideoElement
    expect(preview.getAttribute("src")).toBe("blob:http://jinn.local/clip")
    expect(preview.controls).toBe(false)
    expect(screen.queryByTestId("video-player-element")).toBeNull()
    expect(screen.getByLabelText("Play clip.mp4")).toBeTruthy()
  })

  it("plays the data-saver source with native controls", () => {
    render(<VideoPlayer src="/api/files/clip" name="clip.mp4" />)
    fireEvent.click(screen.getByLabelText("Play clip.mp4"))

    const video = screen.getByTestId("video-player-element") as HTMLVideoElement
    expect(video.getAttribute("src")).toBe("/api/files/clip?quality=low")
    expect(video.controls).toBe(true)
    expect(video.hasAttribute("playsinline")).toBe(true)
  })

  it("preserves time and playing state while switching to Original", () => {
    render(<VideoPlayer src="/api/files/clip" name="clip.mp4" />)
    fireEvent.click(screen.getByLabelText("Play clip.mp4"))
    const video = screen.getByTestId("video-player-element") as HTMLVideoElement
    const play = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(video, "paused", { configurable: true, get: () => false })
    Object.defineProperty(video, "play", { configurable: true, value: play })
    video.currentTime = 42

    fireEvent.change(screen.getByLabelText("Video quality"), { target: { value: "original" } })
    expect(video.getAttribute("src")).toBe("/api/files/clip")
    video.currentTime = 0
    fireEvent.loadedMetadata(video)

    expect(video.currentTime).toBe(42)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("does not autoplay a paused video after changing quality", () => {
    render(<VideoPlayer src="/api/files/clip" name="clip.mp4" />)
    fireEvent.click(screen.getByLabelText("Play clip.mp4"))
    const video = screen.getByTestId("video-player-element") as HTMLVideoElement
    const play = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(video, "paused", { configurable: true, get: () => true })
    Object.defineProperty(video, "play", { configurable: true, value: play })
    video.currentTime = 9

    fireEvent.change(screen.getByLabelText("Video quality"), { target: { value: "original" } })
    expect(video.autoplay).toBe(false)
    video.currentTime = 0
    fireEvent.loadedMetadata(video)

    expect(video.currentTime).toBe(9)
    expect(play).not.toHaveBeenCalled()
  })

  it("falls back to metadata-preload playback when the poster is unavailable", () => {
    render(<VideoPlayer src="/api/files/clip" name="clip.mp4" />)
    fireEvent.error(screen.getByAltText("clip.mp4 preview"))

    const video = screen.getByTestId("video-player-element") as HTMLVideoElement
    expect(video.getAttribute("preload")).toBe("metadata")
    expect(video.getAttribute("src")).toBe("/api/files/clip?quality=low")
    expect(screen.queryByLabelText("Video quality")).toBeNull()
  })
})
