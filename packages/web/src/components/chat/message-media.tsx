import React, { useState, useCallback } from 'react'
import { isVideoMedia, type MediaAttachment } from '@/lib/conversations'
import { FileAttachment } from './file-attachment'
import { VoiceMessage } from './voice-message'
import { Skeleton } from '@/components/ui/skeleton'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { cn } from '@/lib/utils'
import { VideoPlayer } from '@/components/ui/video-player'

/**
 * Thumbnail image with a shimmer skeleton while it loads/decodes, a cross-fade in
 * on `onLoad`, and a graceful broken-image fallback on error (never an infinite
 * skeleton). The skeleton overlays the reserved slot so there's no layout shift.
 */
function LoadingImage({
  src,
  alt,
  variant,
}: {
  src: string
  alt: string
  variant: 'single' | 'grid'
}) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const isGrid = variant === 'grid'

  if (status === 'error') {
    return (
      <div
        role="img"
        aria-label={`${alt} (failed to load)`}
        className={cn(
          'flex items-center justify-center rounded-[var(--radius-lg)] bg-[var(--fill-secondary)] text-[var(--text-tertiary)]',
          isGrid ? 'h-[130px] w-full' : 'h-[140px] w-full',
        )}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          <line x1="3" y1="3" x2="21" y2="21" />
        </svg>
      </div>
    )
  }

  return (
    <div
      className="relative"
      // Reserve the slot so the skeleton has size and the image swap causes no jump.
      style={!isGrid && status === 'loading' ? { minHeight: 140 } : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('error')}
        className={cn(
          'block rounded-[var(--radius-lg)] transition-opacity duration-300',
          isGrid ? 'h-[130px] w-full object-cover' : 'w-full',
          status === 'loaded' ? 'opacity-100' : 'opacity-0',
        )}
      />
      {status === 'loading' && (
        <Skeleton
          data-testid="image-skeleton"
          className="absolute inset-0 h-full w-full rounded-[var(--radius-lg)]"
        />
      )}
    </div>
  )
}

/**
 * Render a message's media. Images go in a responsive grid (single image stays
 * large; multiples tile 2-up) and open a full-screen lightbox on click. Audio
 * uses the voice player; every other type is a downloadable file chip.
 * Handles single AND multiple attachments without clobbering.
 */
export function MessageMedia({ media, isUser }: { media: MediaAttachment[]; isUser: boolean }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const close = useCallback(() => setLightboxIndex(null), [])

  const images = media.filter((m) => m.type === 'image')
  const audio = media.filter((m) => m.type === 'audio')
  const videos = media.filter(isVideoMedia)
  const files = media.filter((m) => m.type !== 'image' && m.type !== 'audio' && !isVideoMedia(m))
  const gallery = images.map((image, index) => ({
    id: String(index),
    url: image.url,
    name: image.name || 'Image',
  }))

  return (
    <>
      {images.length > 0 && (
        <div
          className={
            images.length > 1
              ? 'mt-[var(--space-2)] grid grid-cols-2 gap-[var(--space-2)] w-full max-w-[var(--chat-media-multi,520px)]'
              : 'mt-[var(--space-2)] w-full max-w-[var(--chat-media-single,440px)]'
          }
        >
          {images.map((m, mi) => (
            <button
              key={`img-${mi}`}
              type="button"
              onClick={() => setLightboxIndex(mi)}
              aria-label={`Open ${m.name || 'image'}`}
              className="block overflow-hidden rounded-[var(--radius-lg)] p-0 border-0 bg-transparent cursor-pointer"
            >
              <LoadingImage
                src={m.url}
                alt={m.name || 'Image'}
                variant={images.length > 1 ? 'grid' : 'single'}
              />
            </button>
          ))}
        </div>
      )}

      {audio.map((m, mi) => (
        <div key={`audio-${mi}`} className="mt-[var(--space-2)]">
          <VoiceMessage src={m.url} duration={m.duration || 0} waveform={m.waveform || []} isUser={isUser} />
        </div>
      ))}

      {videos.map((m, mi) => (
        <div key={`video-${mi}`} className="mt-[var(--space-2)]">
          <VideoPlayer src={m.url} name={m.name || 'Video'} />
        </div>
      ))}

      {files.length > 0 && (
        <div className="mt-[var(--space-2)] flex flex-col gap-[var(--space-2)]">
          {files.map((m, mi) => (
            <FileAttachment
              key={`file-${mi}`}
              name={m.name || 'File'}
              size={m.size}
              mimeType={m.mimeType}
              url={m.url}
              isUser={isUser}
            />
          ))}
        </div>
      )}

      {lightboxIndex !== null && gallery[lightboxIndex] && (
        <ImageLightbox
          image={gallery[lightboxIndex]}
          gallery={gallery}
          onNavigate={(image) => setLightboxIndex(Number(image.id))}
          onClose={close}
          closeLabel="Close"
          downloadLabel="Download image"
        />
      )}
    </>
  )
}
