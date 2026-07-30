import { createElement, Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  consumeChunkReloadRetry,
  isRecoverableDynamicImportError,
  lazyRoute,
} from '../lazy-route'

describe('isRecoverableDynamicImportError', () => {
  it('recognizes dynamic import and stale chunk failures', () => {
    expect(isRecoverableDynamicImportError(new TypeError('Failed to fetch dynamically imported module'))).toBe(true)
    expect(isRecoverableDynamicImportError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isRecoverableDynamicImportError(new Error('ChunkLoadError: Loading chunk 123 failed'))).toBe(true)
    expect(
      isRecoverableDynamicImportError(
        new Error('Expected a JavaScript module script but the server responded with a MIME type of text/html'),
      ),
    ).toBe(true)
  })

  it('does not classify ordinary render errors as chunk failures', () => {
    expect(isRecoverableDynamicImportError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isRecoverableDynamicImportError('plain failure')).toBe(false)
  })
})

describe('consumeChunkReloadRetry', () => {
  it('allows one retry per key', () => {
    const storage = new Map<string, string>()
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() { return storage.size },
    } as Storage

    expect(consumeChunkReloadRetry(adapter, 'jinn:chunk-retry:/limits')).toBe(true)
    expect(consumeChunkReloadRetry(adapter, 'jinn:chunk-retry:/limits')).toBe(false)
  })
})

describe('lazyRoute prefetch', () => {
  it('starts one prefetch and retries the real render after a rejected prefetch', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('prefetch failed'))
      .mockResolvedValueOnce({ default: () => createElement('div', null, 'Loaded route') })
    const Route = lazyRoute(load, 'prefetch-probe') as ReturnType<typeof lazyRoute> & {
      prefetch: () => Promise<void>
    }

    await Promise.all([Route.prefetch(), Route.prefetch()])
    expect(load).toHaveBeenCalledTimes(1)

    render(
      createElement(
        Suspense,
        { fallback: createElement('div', null, 'Loading') },
        createElement(Route),
      ),
    )

    expect(await screen.findByText('Loaded route')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
