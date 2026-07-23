import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, Copy, Sparkles } from "lucide-react"
import { api, type InstanceMigration, type OpenInstanceMigrationResult } from "@/lib/api"
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

export function InstanceMigrationGate({
  service = defaultService,
  navigate = (url) => window.location.assign(url),
}: {
  service?: InstanceMigrationService
  navigate?: (url: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const presentedKey = useRef<string | null>(null)
  const launching = useRef(false)
  const query = useQuery({
    queryKey: queryKeys.instanceMigration,
    queryFn: service.get,
    retry: 2,
    retryDelay: 10,
    refetchInterval: 10_000,
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
      setDismissedKey(null)
      setOpen(true)
    }
  }, [migration])

  const launch = useMutation({
    mutationFn: () => service.open(migration!.migrationKey!),
    onSuccess: ({ sessionId }) => navigate(`/?session=${encodeURIComponent(sessionId)}`),
    onError: () => { launching.current = false },
  })

  if (!migration && query.isError) {
    return (
      <div className="fixed inset-x-3 bottom-3 z-40 flex justify-center sm:inset-x-auto sm:right-5 sm:bottom-5">
        <div className="flex w-full max-w-md flex-col gap-3 rounded-2xl bg-[var(--accent-fill)] p-4 text-sm text-foreground shadow-xl" role="alert">
          <span>The migration service is temporarily unavailable. Your setup has not been changed.</span>
          <Button className="min-h-10 self-end" size="sm" variant="outline" onClick={() => void query.refetch()}>
            Retry migration check
          </Button>
        </div>
      </div>
    )
  }

  if (!migration?.required || !migration.migrationKey || !migration.prompt) return null
  if (dismissedKey === migration.migrationKey) return null

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(migration.prompt!)
    setCopied(true)
  }

  return (
    <>
      <div className="fixed inset-x-3 bottom-3 z-40 flex justify-center sm:inset-x-auto sm:right-5 sm:bottom-5">
        <div className="flex w-full max-w-md flex-col items-stretch gap-2 sm:w-auto sm:items-end">
          {(query.isError || query.isRefetchError) && (
            <Button className="min-h-10 self-end" size="sm" variant="outline" onClick={() => void query.refetch()}>
              Retry migration check
            </Button>
          )}
          <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Finish v${migration.toVersion} setup`}
          className="migration-reminder-glow flex min-h-11 w-full max-w-md items-center gap-3 rounded-2xl px-4 py-3 text-left text-white shadow-xl transition-[transform,box-shadow] duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none sm:w-auto"
          style={{ background: "linear-gradient(120deg, var(--system-purple), var(--system-blue))" }}
        >
          <Sparkles className="size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-sm font-semibold text-pretty">Finish v{migration.toVersion} setup</span>
          <span className="rounded-full bg-[var(--accent)] px-2 py-1 text-xs font-semibold text-[var(--accent-contrast)]">Action</span>
          </button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-3xl p-2 shadow-2xl motion-reduce:duration-0 sm:max-w-xl">
          <div className="rounded-[22px] bg-[linear-gradient(145deg,color-mix(in_srgb,var(--system-purple)_16%,var(--bg)),color-mix(in_srgb,var(--system-blue)_10%,var(--bg)))] p-5 sm:p-7">
            <DialogHeader className="gap-4 pr-5 text-left">
              <div className="flex size-11 items-center justify-center rounded-xl text-white shadow-md" style={{ background: "linear-gradient(135deg, var(--system-purple), var(--system-blue))" }}>
                <Sparkles className="size-5" aria-hidden="true" />
              </div>
              <div className="space-y-2">
                <DialogTitle className="text-balance text-2xl leading-tight">v{migration.toVersion} is installed. Your custom setup is safe.</DialogTitle>
                <DialogDescription className="text-pretty text-base leading-6 text-foreground/75">
                  One guided merge will bring your instance up to date. A verified snapshot is created before the COO session starts.
                </DialogDescription>
              </div>
            </DialogHeader>

            <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded-full bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-contrast)]">Setup needed</span>
              <span className="text-foreground/70">v{migration.fromVersion} → v{migration.toVersion}</span>
              <span className="text-foreground/55">{migration.changedFiles.length} files to review</span>
            </div>

            {(query.isError || launch.isError) && (
              <div className="mt-4 rounded-xl bg-[var(--accent-fill)] p-3 text-sm text-foreground" role="alert">
                The migration service is temporarily unavailable. Your reminder remains here.
                <Button className="ml-2 min-h-10" size="sm" variant="outline" onClick={() => void query.refetch()}>Retry migration check</Button>
              </div>
            )}

            <DialogFooter className="mt-7 flex-col-reverse sm:flex-row sm:items-center">
              <Button
                className="min-h-11"
                variant="ghost"
                onClick={() => {
                  setOpen(false)
                  setDismissedKey(migration.migrationKey)
                }}
              >
                Later
              </Button>
              <Button className="min-h-11" variant="outline" onClick={() => void copyPrompt()}>
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                Copy migration prompt
              </Button>
              <Button
                className="min-h-11 bg-[var(--system-purple)] text-white hover:opacity-90"
                disabled={launch.isPending}
                onClick={() => {
                  if (launching.current) return
                  launching.current = true
                  launch.mutate()
                }}
              >
                <Sparkles aria-hidden="true" />
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
