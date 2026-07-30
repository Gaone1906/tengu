import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { compressBuffer, type Encoding } from '../compress.js'
import { serveStatic } from '../server.js'

class FakeResponse extends Writable {
  statusCode = 200
  headers: Record<string, string> = {}
  chunks: Buffer[] = []

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }

  writeHead(statusCode: number, headers?: Record<string, string>) {
    this.statusCode = statusCode
    this.headers = headers ?? {}
    return this
  }

  body() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  bytes() {
    return Buffer.concat(this.chunks)
  }
}

function callServeStatic(
  url: string,
  webDir: string,
  headers: Record<string, string> = {},
  options?: {
    compress?: (encoding: Encoding, input: Buffer) => Buffer
    compressionCache?: {
      entries: Map<string, Buffer>
      totalBytes: number
    }
    compressionCacheMaxEntries?: number
    compressionCacheMaxBytes?: number
  },
) {
  const res = new FakeResponse()
  const handled = serveStatic({ url, headers } as any, res as any, webDir, options)
  return new Promise<{ handled: boolean; res: FakeResponse }>((resolve) => {
    res.on('finish', () => resolve({ handled, res }))
  })
}

describe('web static asset fallback', () => {
  it('does not serve index.html for missing hashed assets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-web-'))
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'index.html'), '<div id="root"></div>')

      const { handled, res } = await callServeStatic('/assets/page-missing.js', dir)

      expect(handled).toBe(true)
      expect(res.statusCode).toBe(404)
      expect(res.headers['Content-Type']).toBe('text/plain')
      expect(res.body()).toContain('Not found')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps SPA fallback for client-side routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-web-'))
    try {
      writeFileSync(join(dir, 'index.html'), '<div id="root"></div>')

      const { handled, res } = await callServeStatic('/limits', dir)

      expect(handled).toBe(true)
      expect(res.statusCode).toBe(200)
      expect(res.headers['Content-Type']).toBe('text/html')
      expect(res.body()).toContain('root')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compresses the same hashed asset and encoding once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-web-'))
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'assets', 'page-abcdefgh.js'), 'const value = "cached";\n'.repeat(500))
      let compressionCount = 0
      const options = {
        compress: (encoding: Encoding, input: Buffer) => {
          compressionCount += 1
          return compressBuffer(encoding, input)
        },
      }

      const first = await callServeStatic(
        '/assets/page-abcdefgh.js',
        dir,
        { 'accept-encoding': 'br' },
        options,
      )
      const second = await callServeStatic(
        '/assets/page-abcdefgh.js',
        dir,
        { 'accept-encoding': 'br' },
        options,
      )

      expect(compressionCount).toBe(1)
      expect(second.res.bytes()).toEqual(first.res.bytes())
      expect(second.res.headers).toEqual(first.res.headers)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds the compressed asset cache by entry count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-web-'))
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'assets', 'first-abcdefgh.js'), 'const first = true;\n'.repeat(500))
      writeFileSync(join(dir, 'assets', 'second-abcdefgh.js'), 'const second = true;\n'.repeat(500))
      let compressionCount = 0
      const options = {
        compressionCache: { entries: new Map<string, Buffer>(), totalBytes: 0 },
        compressionCacheMaxEntries: 1,
        compressionCacheMaxBytes: Number.POSITIVE_INFINITY,
        compress: (encoding: Encoding, input: Buffer) => {
          compressionCount += 1
          return compressBuffer(encoding, input)
        },
      }
      const headers = { 'accept-encoding': 'gzip' }

      await callServeStatic('/assets/first-abcdefgh.js', dir, headers, options)
      await callServeStatic('/assets/second-abcdefgh.js', dir, headers, options)
      await callServeStatic('/assets/first-abcdefgh.js', dir, headers, options)

      expect(compressionCount).toBe(3)
      expect(options.compressionCache.entries.size).toBeLessThanOrEqual(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds the compressed asset cache by total bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-web-'))
    try {
      mkdirSync(join(dir, 'assets'))
      const firstContents = 'const firstValue = "one";\n'.repeat(500)
      const secondContents = 'const secondValue = "two";\n'.repeat(500)
      writeFileSync(join(dir, 'assets', 'first-ijklmnop.js'), firstContents)
      writeFileSync(join(dir, 'assets', 'second-ijklmnop.js'), secondContents)
      let compressionCount = 0
      const maxBytes = Math.max(
        compressBuffer('gzip', Buffer.from(firstContents)).byteLength,
        compressBuffer('gzip', Buffer.from(secondContents)).byteLength,
      )
      const options = {
        compressionCache: { entries: new Map<string, Buffer>(), totalBytes: 0 },
        compressionCacheMaxEntries: Number.POSITIVE_INFINITY,
        compressionCacheMaxBytes: maxBytes,
        compress: (encoding: Encoding, input: Buffer) => {
          compressionCount += 1
          return compressBuffer(encoding, input)
        },
      }
      const headers = { 'accept-encoding': 'gzip' }

      await callServeStatic('/assets/first-ijklmnop.js', dir, headers, options)
      await callServeStatic('/assets/second-ijklmnop.js', dir, headers, options)
      await callServeStatic('/assets/first-ijklmnop.js', dir, headers, options)

      expect(compressionCount).toBe(3)
      expect(options.compressionCache.totalBytes).toBeLessThanOrEqual(maxBytes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keys cached bytes by resolved path, mtime, and encoding', async () => {
    const firstDir = mkdtempSync(join(tmpdir(), 'jinn-web-'))
    const secondDir = mkdtempSync(join(tmpdir(), 'jinn-web-'))
    try {
      mkdirSync(join(firstDir, 'assets'))
      mkdirSync(join(secondDir, 'assets'))
      const relativePath = join('assets', 'page-qrstuvwx.js')
      const firstPath = join(firstDir, relativePath)
      writeFileSync(firstPath, 'const version = "first";\n'.repeat(500))
      writeFileSync(join(secondDir, relativePath), 'const version = "other-directory";\n'.repeat(500))
      let compressionCount = 0
      const options = {
        compressionCache: { entries: new Map<string, Buffer>(), totalBytes: 0 },
        compressionCacheMaxEntries: Number.POSITIVE_INFINITY,
        compressionCacheMaxBytes: Number.POSITIVE_INFINITY,
        compress: (encoding: Encoding, input: Buffer) => {
          compressionCount += 1
          return compressBuffer(encoding, input)
        },
      }

      const first = await callServeStatic(
        '/assets/page-qrstuvwx.js',
        firstDir,
        { 'accept-encoding': 'gzip' },
        options,
      )
      const otherDirectory = await callServeStatic(
        '/assets/page-qrstuvwx.js',
        secondDir,
        { 'accept-encoding': 'gzip' },
        options,
      )
      const brotli = await callServeStatic(
        '/assets/page-qrstuvwx.js',
        firstDir,
        { 'accept-encoding': 'br' },
        options,
      )

      writeFileSync(firstPath, 'const version = "rebuilt";\n'.repeat(500))
      const future = new Date(statSync(firstPath).mtimeMs + 5_000)
      utimesSync(firstPath, future, future)
      const rebuilt = await callServeStatic(
        '/assets/page-qrstuvwx.js',
        firstDir,
        { 'accept-encoding': 'gzip' },
        options,
      )

      expect(compressionCount).toBe(4)
      expect(zlib.gunzipSync(first.res.bytes()).toString()).toContain('"first"')
      expect(zlib.gunzipSync(otherDirectory.res.bytes()).toString()).toContain('"other-directory"')
      expect(zlib.brotliDecompressSync(brotli.res.bytes()).toString()).toContain('"first"')
      expect(zlib.gunzipSync(rebuilt.res.bytes()).toString()).toContain('"rebuilt"')
    } finally {
      rmSync(firstDir, { recursive: true, force: true })
      rmSync(secondDir, { recursive: true, force: true })
    }
  })

  it('keeps non-hashed assets on the streaming compression path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-web-'))
    try {
      const contents = 'const unhashed = true;\n'.repeat(500)
      writeFileSync(join(dir, 'runtime.js'), contents)
      let bufferedCompressionCount = 0
      const options = {
        compress: (encoding: Encoding, input: Buffer) => {
          bufferedCompressionCount += 1
          return compressBuffer(encoding, input)
        },
      }

      const response = await callServeStatic(
        '/runtime.js',
        dir,
        { 'accept-encoding': 'gzip' },
        options,
      )

      expect(bufferedCompressionCount).toBe(0)
      expect(response.res.headers['Content-Encoding']).toBe('gzip')
      expect(zlib.gunzipSync(response.res.bytes()).toString()).toBe(contents)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
