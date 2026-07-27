import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, ChevronRight, Copy } from "lucide-react"
import { ApiError, api, type InstanceMigration, type OpenInstanceMigrationResult } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface InstanceMigrationService {
  get: () => Promise<InstanceMigration>
  open: (migrationKey: string) => Promise<OpenInstanceMigrationResult>
}

const defaultService: InstanceMigrationService = {
  get: api.getInstanceMigration,
  open: api.openInstanceMigration,
}

const dismissedStorageKey = "jinn.instance-migration.dismissed-key"

function readDismissedKey(): string | null {
  try {
    return window.localStorage.getItem(dismissedStorageKey)
  } catch {
    return null
  }
}

function writeDismissedKey(migrationKey: string): void {
  try {
    window.localStorage.setItem(dismissedStorageKey, migrationKey)
  } catch {
    // The in-memory dismissal below still works when storage is unavailable.
  }
}

export function InstanceMigrationGate({
  service = defaultService,
  navigate = (url) => window.location.assign(url),
}: {
  service?: InstanceMigrationService
  navigate?: (url: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => readDismissedKey())
  const presentedKey = useRef<string | null>(null)
  const launching = useRef(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const query = useQuery({
    queryKey: queryKeys.instanceMigration,
    queryFn: service.get,
    retry: false,
    placeholderData: (previous) => previous,
  })
  const migration = query.data

  useEffect(() => {
    if (!migration?.required || !migration.migrationKey) {
      setOpen(false)
      setDismissedKey(null)
      presentedKey.current = null
      return
    }
    if (presentedKey.current !== migration.migrationKey) {
      presentedKey.current = migration.migrationKey
      const wasDismissed = readDismissedKey() === migration.migrationKey
      setDismissedKey(wasDismissed ? migration.migrationKey : null)
      setOpen(!wasDismissed)
    }
  }, [migration])

  const rememberAcknowledged = (migrationKey: string) => {
    writeDismissedKey(migrationKey)
  }

  const dismiss = (migrationKey: string) => {
    rememberAcknowledged(migrationKey)
    setOpen(false)
    setDismissedKey(migrationKey)
  }

  const launch = useMutation({
    mutationFn: () => service.open(migration!.migrationKey!),
    onSuccess: ({ sessionId }) => {
      rememberAcknowledged(migration!.migrationKey!)
      navigate(`/?session=${encodeURIComponent(sessionId)}`)
    },
    onError: () => { launching.current = false },
  })
  const launchRemedy = launch.error instanceof ApiError ? launch.error.remedy : undefined

  if (!migration?.required || !migration.migrationKey || !migration.prompt) return null
  if (dismissedKey === migration.migrationKey) return null

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(migration.prompt!)
    rememberAcknowledged(migration.migrationKey!)
    setCopied(true)
  }

  return (
    <>
      <div className="fixed inset-x-3 bottom-[calc(49px+var(--safe-bottom)+0.75rem)] z-40 flex justify-center sm:inset-x-auto sm:right-5 lg:bottom-5">
        <div className="flex w-full max-w-sm flex-col items-stretch gap-2 sm:w-auto sm:items-end">
          {(query.isError || query.isRefetchError) && (
            <Button className="min-h-10 self-end" size="sm" variant="ghost" onClick={() => void query.refetch()}>
              Retry migration check
            </Button>
          )}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Finish v${migration.toVersion} setup`}
            className="group flex min-h-11 w-full items-center gap-2.5 rounded-full bg-[var(--pill-bg)] px-4 py-2.5 text-left shadow-[var(--shadow-overlay)] backdrop-blur-xl transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none sm:w-auto"
          >
            <span className="relative flex size-2 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex size-2 rounded-full bg-[var(--accent)]" />
            </span>
            <span className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">Finish v{migration.toVersion} setup</span>
            <ChevronRight className="size-4 shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 ease-out group-active:translate-x-0.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] max-w-[calc(100%-1.5rem)] rounded-[var(--radius-2xl)] border-0 bg-transparent p-0 shadow-[var(--shadow-overlay)] motion-reduce:duration-0 sm:max-w-md"
          onOpenAutoFocus={(event) => {
            // This is an informational modal — Radix would auto-focus the first
            // action (Later), lighting the loud focus ring on the quiet dismiss.
            // Anchor focus on the title instead; Tab then flows into the actions.
            event.preventDefault()
            titleRef.current?.focus()
          }}
        >
          <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[var(--radius-2xl)] bg-[var(--bg-secondary)] p-6 sm:p-7">
            <DialogHeader className="gap-4 pr-8 text-left">
              <div
                className="flex size-11 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--fill-secondary)] text-[22px] leading-none [font-variant-emoji:emoji]"
                aria-hidden="true"
              >
                {"\u{1F9DE}\u{FE0F}"}
              </div>
              <div className="space-y-2">
                <DialogTitle
                  ref={titleRef}
                  tabIndex={-1}
                  className="text-balance text-[length:var(--text-title2)] font-semibold leading-snug text-[var(--text-primary)] outline-none"
                >
                  v{migration.toVersion} is installed. Your custom setup is safe.
                </DialogTitle>
                <DialogDescription className="text-pretty text-[length:var(--text-subheadline)] leading-6 text-[var(--text-secondary)]">
                  One guided merge brings your instance up to date. A verified snapshot is created before the COO session starts.
                </DialogDescription>
              </div>
            </DialogHeader>

            <div className="mt-5 flex flex-wrap items-center gap-2 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              <span>v{migration.fromVersion} → v{migration.toVersion}</span>
              <span className="size-1 shrink-0 rounded-full bg-[var(--text-quaternary)]" aria-hidden="true" />
              <span>{migration.changedFiles.length} {migration.changedFiles.length === 1 ? "file" : "files"} to review</span>
            </div>

            {(query.isError || launch.isError) && (
              <div className="mt-5 rounded-[var(--radius-lg)] bg-[var(--fill-secondary)] p-3 text-[length:var(--text-footnote)] text-[var(--text-secondary)]" role="alert">
                {launchRemedy ? (
                  // A cause the operator can actually act on beats a generic
                  // "temporarily unavailable", which reads as "wait and retry"
                  // for a condition that will never clear on its own.
                  <span>{launchRemedy}</span>
                ) : (
                  <span>The migration service is temporarily unavailable. Your reminder remains here.</span>
                )}
                <Button className="ml-2 min-h-10" size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry migration check</Button>
              </div>
            )}

            <DialogFooter className="mt-7 gap-2 sm:items-center">
              <Button
                className="w-full min-h-11 text-[var(--text-secondary)] sm:mr-auto sm:w-auto"
                variant="ghost"
                onClick={() => dismiss(migration.migrationKey!)}
              >
                Later
              </Button>
              <Button
                className="w-full min-h-11 bg-[var(--fill-secondary)] text-[var(--text-primary)] hover:bg-[var(--fill-primary)] sm:w-auto"
                variant="ghost"
                onClick={() => void copyPrompt()}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                Copy migration prompt
              </Button>
              <Button
                className="w-full min-h-11 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 sm:w-auto"
                disabled={launch.isPending}
                onClick={() => {
                  if (launching.current) return
                  launching.current = true
                  launch.mutate()
                }}
              >
                {launch.isPending ? "Opening…" : "Open with COO"}
              </Button>
            </DialogFooter>
            <span className="sr-only" role="status" aria-live="polite">{copied ? "Migration prompt copied" : ""}</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
