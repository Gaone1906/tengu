const routePrefetchers = new Map<string, () => Promise<void>>()

export function registerRoutePrefetch(href: string, prefetch: () => Promise<void>): void {
  routePrefetchers.set(href, prefetch)
}

export function prefetchRoute(href: string): void {
  void routePrefetchers.get(href)?.()
}
