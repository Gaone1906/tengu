import { useEffect, useState } from "react"

type IdleDeadlineLike = {
  didTimeout: boolean
  timeRemaining: () => number
}

type IdleCallback = (deadline: IdleDeadlineLike) => void

type IdleCapableWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: IdleCallback, options?: { timeout?: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

export function runAfterIdle(callback: () => void, timeout = 1000): () => void {
  if (typeof window === "undefined") {
    callback()
    return () => {}
  }

  const idleWindow = window as IdleCapableWindow
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(() => callback(), { timeout })
    return () => idleWindow.cancelIdleCallback?.(handle)
  }

  const handle = window.setTimeout(callback, 250)
  return () => window.clearTimeout(handle)
}

export function useIdleMount(enabled = true, timeout = 1000): boolean {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (!enabled || mounted) return
    return runAfterIdle(() => setMounted(true), timeout)
  }, [enabled, mounted, timeout])

  return mounted
}
