import { describe, it, expect } from "vitest"
import { embed, DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../embeddings.js"

describe("embed", () => {
  it("returns an empty array for empty input without loading the model", async () => {
    const vectors = await embed([])
    expect(vectors).toEqual([])
  })

  it(
    "loads the real local ONNX model and produces normalized 384-dim vectors",
    async () => {
      const vectors = await embed(["The quick brown fox jumps over the lazy dog.", "TypeScript is a typed superset of JavaScript."])

      expect(vectors.length).toBe(2)
      for (const vector of vectors) {
        expect(vector.length).toBe(EMBEDDING_DIMENSIONS)
        expect(vector.every((n) => typeof n === "number" && Number.isFinite(n))).toBe(true)
        const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0))
        expect(norm).toBeGreaterThan(0.99)
        expect(norm).toBeLessThan(1.01)
      }

      const [a, b] = vectors
      const dot = a.reduce((sum, n, i) => sum + n * b[i], 0)
      expect(dot).toBeGreaterThan(-1.01)
      expect(dot).toBeLessThan(1.01)
    },
    120_000,
  )

  it(
    "reuses the same lazily-loaded pipeline across calls (module-level singleton)",
    async () => {
      const first = await embed(["hello world"], { model: DEFAULT_EMBEDDING_MODEL })
      const start = Date.now()
      const second = await embed(["a different sentence entirely"], { model: DEFAULT_EMBEDDING_MODEL })
      const elapsed = Date.now() - start

      expect(first[0].length).toBe(EMBEDDING_DIMENSIONS)
      expect(second[0].length).toBe(EMBEDDING_DIMENSIONS)
      expect(elapsed).toBeLessThan(30_000)
    },
    120_000,
  )
})
