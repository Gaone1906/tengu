import { useEffect, useState, type FormEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { api, type CreateWorkspaceResult } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  create?: (input: { name: string }) => Promise<CreateWorkspaceResult>
  navigate?: (url: string) => void
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  create = api.createWorkspace,
  navigate = (url) => window.location.assign(url),
}: CreateWorkspaceDialogProps) {
  const [name, setName] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) return
    setName("")
    setError(null)
    setPending(false)
  }, [open])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || pending) return
    setPending(true)
    setError(null)
    try {
      const result = await create({ name: trimmed })
      navigate(result.launchUrl)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Workspace could not be created")
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <DialogContent
        className="w-[min(420px,calc(100vw-24px))] gap-0 rounded-[var(--radius-xl)] border-0 bg-[var(--material-regular)] p-2 shadow-[var(--shadow-overlay)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <form onSubmit={submit}>
          <div className="p-5">
            <DialogHeader className="gap-2 text-left">
              <DialogTitle className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                New workspace
              </DialogTitle>
              <DialogDescription className="text-pretty text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-secondary)]">
                Creates a separate Jinn company with its own people, chats, skills, and setup.
              </DialogDescription>
            </DialogHeader>
            <label htmlFor="workspace-name" className="mt-5 block text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-secondary)]">
              Workspace name
            </label>
            <input
              id="workspace-name"
              autoFocus
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme"
              disabled={pending}
              className="mt-2 h-11 w-full rounded-[var(--radius-md)] border-0 bg-[var(--fill-secondary)] px-3 text-[16px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] focus-visible:ring-2 focus-visible:ring-[var(--system-blue)]"
            />
            <p className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              Jinn creates a private home such as <span style={{ fontFamily: "var(--font-code)" }}>~/.jinn-acme</span>, starts it, and opens onboarding.
            </p>
            {error && <p role="alert" className="mt-3 text-[length:var(--text-footnote)] text-[var(--system-red)]">{error}</p>}
          </div>
          <DialogFooter className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-3 sm:items-center">
            <button
              type="button"
              disabled={pending}
              onClick={() => onOpenChange(false)}
              className="min-h-10 rounded-[var(--radius-md)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || pending}
              className="inline-flex min-h-10 min-w-[144px] items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-transform active:scale-[0.96] disabled:opacity-45"
            >
              {pending && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
              {pending ? "Creating workspace…" : "Create workspace"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
