import { useRef, useState } from "react"
import { Download, Play } from "lucide-react"
import { cn } from "@/lib/utils"

type VideoQuality = "low" | "original"

interface PlaybackSnapshot {
  currentTime: number
  paused: boolean
}

function sourceWith(src: string, params: Record<string, string | null>): string {
  if (/^(?:blob:|data:)/.test(src)) return src
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(src)
  const url = new URL(src, "http://jinn.local")
  for (const [key, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(key)
    else url.searchParams.set(key, value)
  }
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`
}

function playbackSource(src: string, quality: VideoQuality): string {
  return sourceWith(src, {
    poster: null,
    download: null,
    quality: quality === "low" ? "low" : null,
  })
}

export function VideoPlayer({ src, name, className }: { src: string; name: string; className?: string }) {
  const [quality, setQuality] = useState<VideoQuality>("low")
  const [playing, setPlaying] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const restore = useRef<PlaybackSnapshot | null>(null)
  const poster = /^(?:blob:|data:)/.test(src) ? null : sourceWith(src, { quality: null, download: null, poster: "1" })
  const showVideo = playing || posterFailed
  const canChooseQuality = poster !== null && !posterFailed

  const restorePlayback = () => {
    const video = videoRef.current
    const snapshot = restore.current
    if (!video || !snapshot) return
    video.currentTime = snapshot.currentTime
    restore.current = null
    if (!snapshot.paused) void video.play().catch(() => {})
  }

  const changeQuality = (next: VideoQuality) => {
    const video = videoRef.current
    if (video) restore.current = { currentTime: video.currentTime, paused: video.paused }
    setQuality(next)
  }

  return (
    <div
      data-testid="video-player"
      className={cn(
        "relative aspect-video w-full max-w-[560px] overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg-tertiary)] shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          data-testid="video-player-element"
          src={playbackSource(src, quality)}
          controls
          playsInline
          autoPlay={playing && restore.current === null}
          preload="metadata"
          onLoadedMetadata={restorePlayback}
          className="block size-full bg-[var(--bg-tertiary)] object-contain"
        />
      ) : (
        <>
          {poster ? (
            <img
              src={poster}
              alt={`${name} preview`}
              loading="lazy"
              decoding="async"
              onError={() => setPosterFailed(true)}
              className="block size-full object-cover"
            />
          ) : (
            <video
              data-testid="video-player-preview"
              src={src}
              playsInline
              preload="metadata"
              aria-hidden
              className="block size-full bg-[var(--bg-tertiary)] object-contain"
            />
          )}
          <button
            type="button"
            aria-label={`Play ${name}`}
            onClick={() => setPlaying(true)}
            className="focus-ring absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--material-thick)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] outline-none backdrop-blur-xl transition-transform active:scale-[0.96]"
          >
            <Play size={20} fill="currentColor" strokeWidth={1.5} aria-hidden className="ml-0.5" />
          </button>
        </>
      )}

      <div className="absolute right-2 top-2 flex items-center gap-1.5">
        {showVideo && canChooseQuality && (
          <select
            aria-label="Video quality"
            value={quality}
            onChange={(event) => changeQuality(event.target.value as VideoQuality)}
            className="focus-ring h-10 appearance-none rounded-[var(--radius-md)] bg-[var(--material-thick)] px-3 text-[12px] font-medium text-[var(--text-primary)] shadow-[var(--shadow-overlay)] outline-none backdrop-blur-xl"
          >
            <option value="low">Data saver</option>
            <option value="original">Original</option>
          </select>
        )}
        <a
          href={sourceWith(src, { quality: null, poster: null, download: "1" })}
          download={name}
          aria-label={`Download ${name}`}
          className="focus-ring grid size-10 place-items-center rounded-[var(--radius-md)] bg-[var(--material-thick)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] outline-none backdrop-blur-xl transition-transform active:scale-[0.96]"
        >
          <Download size={17} strokeWidth={1.8} aria-hidden />
        </a>
      </div>
    </div>
  )
}
