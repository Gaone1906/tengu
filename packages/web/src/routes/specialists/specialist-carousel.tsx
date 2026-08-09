import { ChevronLeft, ChevronRight, Database, GraduationCap, MessageSquare, RefreshCw } from "lucide-react"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { cn } from "@/lib/utils"
import type { SpecialistKbManifest } from "@/lib/api"

/**
 * The carousel's own view of a specialist — a subset of `Employee` so tests
 * (and future callers) don't need to construct a full roster row.
 */
export interface CarouselSpecialist {
  name: string
  displayName: string
  repo?: string
  model?: string
  effortLevel?: string
}

interface SpecialistCarouselProps {
  specialists: CarouselSpecialist[]
  activeIndex: number
  onChangeIndex: (index: number) => void
  /** KB manifest for the active card only — fetched on demand, not per card. */
  kbManifest?: SpecialistKbManifest | null
  kbExists?: boolean
  kbLoading?: boolean
  onStartChat: (name: string) => void
  /** False until Lane A's `knowledge-base/teaching.ts` lands — renders the
   *  teaching action as a disabled "not yet available" affordance instead of
   *  blocking the rest of the carousel on it. */
  teachingAvailable: boolean
  onTriggerTeaching: (name: string) => void
  onTriggerIncrementalLearning: (name: string) => void
  incrementalPending?: boolean
  incrementalTriggered?: boolean
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "never"
  return d.toLocaleString()
}

function KbPanel({
  loading,
  exists,
  manifest,
}: {
  loading: boolean | undefined
  exists: boolean | undefined
  manifest: SpecialistKbManifest | null | undefined
}) {
  return (
    <div
      data-testid="kb-panel"
      className="mt-4 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-3.5"
    >
      <div className="flex items-center gap-1.5 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-wider text-[var(--text-tertiary)]">
        <Database size={12} strokeWidth={2.4} aria-hidden />
        Knowledge base
      </div>
      {loading ? (
        <p className="mt-2 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]" data-testid="kb-loading">
          Loading…
        </p>
      ) : exists && manifest ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[length:var(--text-footnote)]">
          <dt className="text-[var(--text-tertiary)]">Last indexed</dt>
          <dd className="text-[var(--text-primary)]">{formatDate(manifest.lastIndexedAt)}</dd>
          <dt className="text-[var(--text-tertiary)]">Files</dt>
          <dd className="text-[var(--text-primary)] tabular-nums">{manifest.fileCount}</dd>
          <dt className="text-[var(--text-tertiary)]">Chunks</dt>
          <dd className="text-[var(--text-primary)] tabular-nums">{manifest.chunkCount}</dd>
        </dl>
      ) : (
        <p
          className="mt-2 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]"
          data-testid="kb-empty"
        >
          No knowledge base yet — run the learning phase to index this repo.
        </p>
      )}
    </div>
  )
}

function SpecialistCard({
  specialist,
  kbExists,
  kbLoading,
  kbManifest,
  onStartChat,
  teachingAvailable,
  onTriggerTeaching,
  onTriggerIncrementalLearning,
  incrementalPending,
  incrementalTriggered,
}: {
  specialist: CarouselSpecialist
} & Omit<SpecialistCarouselProps, "specialists" | "activeIndex" | "onChangeIndex">) {
  return (
    <div
      data-testid={`specialist-card-${specialist.name}`}
      className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-5 shadow-[var(--shadow-card)]"
    >
      <div className="flex items-center gap-3">
        <EmployeeAvatar name={specialist.name} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
            {specialist.displayName}
          </h2>
          <p
            className="truncate text-[length:var(--text-caption1)] text-[var(--text-quaternary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {specialist.repo ?? "no repo configured"}
          </p>
        </div>
        {(specialist.model || specialist.effortLevel) && (
          <span className="shrink-0 rounded-full bg-[var(--fill-tertiary)] px-2.5 py-1 text-[length:var(--text-caption2)] font-medium text-[var(--text-secondary)]">
            {[specialist.model, specialist.effortLevel].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>

      <KbPanel loading={kbLoading} exists={kbExists} manifest={kbManifest} />

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="action-chat"
          onClick={() => onStartChat(specialist.name)}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-full px-3.5 text-[length:var(--text-footnote)] font-semibold text-[var(--accent)] transition-transform hover:scale-[0.98]"
          style={{ background: "var(--accent-fill)" }}
        >
          <MessageSquare size={14} strokeWidth={2.4} aria-hidden />
          Chat
        </button>

        <button
          type="button"
          data-testid="action-incremental-learning"
          disabled={incrementalPending}
          onClick={() => onTriggerIncrementalLearning(specialist.name)}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-full bg-[var(--fill-tertiary)] px-3.5 text-[length:var(--text-footnote)] font-medium text-[var(--text-secondary)] transition-transform hover:scale-[0.98] disabled:opacity-70"
        >
          <RefreshCw size={14} strokeWidth={2.4} className={incrementalPending ? "animate-spin" : undefined} aria-hidden />
          {incrementalTriggered ? "Triggered" : "Re-run incremental learning"}
        </button>

        <button
          type="button"
          data-testid="action-teach"
          disabled={!teachingAvailable}
          title={teachingAvailable ? undefined : "Not yet available — waiting on knowledge-base/teaching.ts"}
          onClick={() => onTriggerTeaching(specialist.name)}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-full bg-[var(--fill-tertiary)] px-3.5 text-[length:var(--text-footnote)] font-medium text-[var(--text-secondary)] transition-transform hover:scale-[0.98] disabled:opacity-50"
        >
          <GraduationCap size={14} strokeWidth={2.4} aria-hidden />
          {teachingAvailable ? "Trigger teaching session" : "Teaching session — not yet available"}
        </button>
      </div>
    </div>
  )
}

/** Pages through the specialist roster one card at a time. Wraps around at
 *  both ends — with a small roster, "one more" should never dead-end. */
export function SpecialistCarousel({
  specialists,
  activeIndex,
  onChangeIndex,
  ...cardProps
}: SpecialistCarouselProps) {
  const count = specialists.length

  if (count === 0) {
    return (
      <div
        data-testid="specialist-carousel-empty"
        className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-6 py-12 text-center shadow-[var(--shadow-card)]"
      >
        <h3 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
          No specialists yet
        </h3>
        <p className="mx-auto mt-2 max-w-[360px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
          Specialists are hired through the specialist creation wizard, not written by hand —
          it's the only path that also builds the knowledge base a specialist needs.
        </p>
      </div>
    )
  }

  const clamped = ((activeIndex % count) + count) % count
  const active = specialists[clamped]
  const goPrev = () => onChangeIndex((clamped - 1 + count) % count)
  const goNext = () => onChangeIndex((clamped + 1) % count)

  return (
    <div
      data-testid="specialist-carousel"
      role="group"
      aria-roledescription="carousel"
      aria-label="Specialist roster"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault()
          goPrev()
        } else if (e.key === "ArrowRight") {
          e.preventDefault()
          goNext()
        }
      }}
      className="outline-none"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Previous specialist"
          data-testid="carousel-prev"
          onClick={goPrev}
          disabled={count < 2}
          className="grid size-[34px] flex-none place-items-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] disabled:opacity-40"
        >
          <ChevronLeft size={16} strokeWidth={2.4} aria-hidden />
        </button>

        <div className="min-w-0 flex-1">
          <SpecialistCard specialist={active} {...cardProps} />
        </div>

        <button
          type="button"
          aria-label="Next specialist"
          data-testid="carousel-next"
          onClick={goNext}
          disabled={count < 2}
          className="grid size-[34px] flex-none place-items-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] disabled:opacity-40"
        >
          <ChevronRight size={16} strokeWidth={2.4} aria-hidden />
        </button>
      </div>

      {count > 1 && (
        <div className="mt-4 flex items-center justify-center gap-1.5" role="tablist" aria-label="Jump to specialist">
          {specialists.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === clamped}
              aria-label={s.displayName}
              data-testid={`carousel-dot-${s.name}`}
              onClick={() => onChangeIndex(i)}
              className={cn(
                "h-2 rounded-full transition-all",
                i === clamped ? "w-5 bg-[var(--accent)]" : "w-2 bg-[var(--fill-secondary)] hover:bg-[var(--fill-primary)]"
              )}
            />
          ))}
        </div>
      )}
    </div>
  )
}
