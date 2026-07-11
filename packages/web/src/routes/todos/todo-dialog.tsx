import { Dialog as DialogPrimitive } from "radix-ui"
import { useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

/** Shared focus scope for Todo sheets and creation dialogs. Radix owns focus
 * trapping, scroll lock, Escape dispatch, outside interaction, and focus
 * restoration; callers own the dirty-close policy. */
export function TodoDialog({
  label,
  onRequestClose,
  children,
  className,
  testId,
  overlayTestId,
}: {
  label: string
  onRequestClose: () => void
  children: React.ReactNode
  className?: string
  testId?: string
  overlayTestId?: string
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(() => () => {
    const opener = openerRef.current
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus()
    })
  }, [])
  const requestClose = useCallback(() => {
    onRequestClose()
  }, [onRequestClose])

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) requestClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid={overlayTestId}
          className="fixed inset-0 z-50 bg-[var(--scrim)] motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 md:bg-transparent"
        />
        <DialogPrimitive.Content
          ref={contentRef}
          tabIndex={-1}
          data-testid={testId}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus()
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            if (document.activeElement instanceof HTMLElement && document.activeElement.closest("[data-todo-field-edit]")) return
            requestClose()
          }}
          className={cn("fixed z-50 outline-none", className)}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
