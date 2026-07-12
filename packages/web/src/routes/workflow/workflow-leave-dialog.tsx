import { useRef, type RefObject } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export function WorkflowLeaveDialog({
  open,
  resolving,
  canSave,
  returnFocusRef,
  onStay,
  onDiscard,
  onSave,
}: {
  open: boolean
  resolving: boolean
  canSave: boolean
  returnFocusRef: RefObject<HTMLElement | null>
  onStay: () => void
  onDiscard: () => void
  onSave: () => void
}) {
  const stayRef = useRef<HTMLButtonElement | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !resolving) onStay()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-full max-w-sm gap-0 rounded-[var(--radius-xl)] border-0 bg-[var(--material-thick)] p-5 shadow-[var(--shadow-overlay)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          stayRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = returnFocusRef.current
          returnFocusRef.current = null
          if (target?.isConnected) target.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (resolving) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogTitle className="text-balance text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          Unsaved workflow edits
        </DialogTitle>
        <DialogDescription className="mt-1.5 text-pretty text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-secondary)]">
          Save your geometry and workflow changes before leaving?
        </DialogDescription>
        <div className="mt-5 flex items-center justify-end gap-1.5">
          <button
            ref={stayRef}
            type="button"
            onClick={onStay}
            disabled={resolving}
            className="min-h-10 rounded-[var(--radius-md)] px-3 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-[background-color,scale] duration-150 hover:bg-[var(--fill-secondary)] active:scale-[0.96] disabled:opacity-50"
          >
            Stay
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={resolving}
            className="min-h-10 rounded-[var(--radius-md)] px-3 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--system-red)] transition-[background-color,scale] duration-150 hover:bg-[color-mix(in_srgb,var(--system-red)_10%,transparent)] active:scale-[0.96] disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={resolving || !canSave}
            className="min-h-10 rounded-[var(--radius-md)] bg-[var(--accent)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-[opacity,scale] duration-150 active:scale-[0.96] disabled:opacity-50"
          >
            {resolving ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
