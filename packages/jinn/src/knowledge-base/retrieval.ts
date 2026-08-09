import { logger } from "../shared/logger.js"
import { embed, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js"
import { initKbDb, searchChunks, type ChunkSearchHit, type KbChunkSource } from "./store.js"

/**
 * The sole read path into a specialist's KB (docs/tengu/18-council-specialists.md):
 * embed the query, run KNN over the specialist's `vec0` table, then cap what
 * comes back to a fixed total character budget. Mirrors mcp/knowledge-tools.ts's
 * `search_knowledge` discipline (<=20 hits, content never inlined wholesale) —
 * here the cap is a total-chars budget rather than a per-hit snippet, since
 * callers need enough of a chunk to act on it, just not the whole KB at once.
 * Nothing else in this codebase should call store.ts's searchChunks directly.
 */

export interface RetrievalEmployee {
  name: string
}

export interface RetrieveOptions {
  /** Overrides `~/.{instance}/kb` — tests only. */
  kbRoot?: string
  embeddingModel?: string
  /** Fixed total character budget across every returned chunk's text. */
  maxTotalChars?: number
}

export interface RetrievedChunk {
  path: string
  startLine: number
  endLine: number
  symbolName: string | null
  text: string
  source: KbChunkSource
  distance: number
  /** True when `text` was cut short to stay inside the total char budget. */
  truncated: boolean
}

const DEFAULT_K = 8
/** Same shape as mcp/knowledge-tools.ts's hit cap — no caller-supplied `k` can exceed this. */
export const MAX_RETRIEVAL_HITS = 20
export const DEFAULT_MAX_TOTAL_CHARS = 8_000

function boundToCharBudget(hits: readonly ChunkSearchHit[], maxTotalChars: number): RetrievedChunk[] {
  const result: RetrievedChunk[] = []
  let remaining = maxTotalChars
  for (const hit of hits) {
    if (remaining <= 0) break
    const fits = hit.text.length <= remaining
    const text = fits ? hit.text : hit.text.slice(0, remaining)
    result.push({
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      symbolName: hit.symbolName,
      text,
      source: hit.source,
      distance: hit.distance,
      truncated: !fits,
    })
    remaining -= text.length
  }
  return result
}

/**
 * Rank a specialist's KB against `queryText` and return up to `k` chunks
 * (hard-capped at {@link MAX_RETRIEVAL_HITS}), most-relevant first, trimmed to
 * fit within `options.maxTotalChars` total. Blends `source: 'code'` and
 * `source: 'teaching'` chunks identically — retrieval has no special-casing
 * for either.
 */
export async function retrieveForTask(
  employee: RetrievalEmployee,
  queryText: string,
  k: number = DEFAULT_K,
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const trimmedQuery = queryText.trim()
  if (!trimmedQuery) return []

  const boundedK = Math.max(0, Math.min(k, MAX_RETRIEVAL_HITS))
  if (boundedK === 0) return []

  const model = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
  const [queryEmbedding] = await embed([trimmedQuery], { model })

  const db = initKbDb(employee.name, options.kbRoot)
  const hits = searchChunks(db, queryEmbedding, boundedK)

  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS
  const bounded = boundToCharBudget(hits, maxTotalChars)
  logger.info(
    `knowledge-base/retrieval: ${employee.name} retrieved ${bounded.length}/${hits.length} chunk(s) ` +
      `for query "${trimmedQuery.slice(0, 80)}" within a ${maxTotalChars}-char budget`,
  )
  return bounded
}
