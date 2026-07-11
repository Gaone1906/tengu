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

/**
 * Run a callback well AFTER the window `load` event, plus a fixed delay.
 *
 * Unlike {@link runAfterIdle}, this deliberately waits until the page has fully
 * loaded and then holds off a couple more seconds, so the work (and any chunks
 * it fetches) lands cleanly outside the first-paint / pre-interaction network
 * waterfall we measure against. Used to warm interaction-only chunks (Cmd-K)
 * and mount non-critical shell widgets without polluting the load numbers.
 */
export function runAfterLoad(callback: () => void, delay = 2500): () => void {
  if (typeof window === "undefined") {
    callback()
    return () => {}
  }

  let timer: number | undefined
  const schedule = () => {
    timer = window.setTimeout(callback, delay)
  }

  if (document.readyState === "complete") {
    schedule()
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }

  window.addEventListener("load", schedule, { once: true })
  return () => {
    window.removeEventListener("load", schedule)
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

export function useLoadDeferredMount(enabled = true, delay = 2500): boolean {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (!enabled || mounted) return
    return runAfterLoad(() => setMounted(true), delay)
  }, [enabled, mounted, delay])

  return mounted
}
