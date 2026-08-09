import crypto from "node:crypto"
import { logger } from "../shared/logger.js"
import { getMessages, type SessionMessage } from "../sessions/registry.js"
import { chunkText, type ChunkOptions } from "./chunking.js"
import { embed, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js"
import { initKbDb, replaceFileChunks, type ChunkInsert } from "./store.js"

/**
 * The teaching phase (docs/tengu/18-council-specialists.md): a one-time
 * interactive Q&A session for a newly-created specialist. Session creation
 * and idle-for-reply live entirely in the existing `interactive: true`
 * mechanism (Employee.interactive, sessions/manager.ts + gateway/api.ts's
 * dispatchContinuousLoop already excludes such sessions from auto-continuation
 * so the specialist's questions wait for the user's chat reply) — this module
 * does not reimplement that. Its job is the two pieces specific to teaching:
 * seeding the kickoff prompt, and harvesting the finished session's transcript
 * into `source: 'teaching'` chunks in the same store `source: 'code'` chunks
 * live in, so retrieval.ts blends both without special-casing either.
 */

export interface TeachingEmployee {
  name: string
  repo?: string
}

export function buildTeachingKickoffPrompt(employee: TeachingEmployee): string {
  const repoLine = employee.repo ? ` at ${employee.repo}` : ""
  return [
    `You are the newly-created specialist for the repo${repoLine}. Your code knowledge base has ` +
      `already been indexed (the learning phase). This is the teaching phase: ask the user a short, ` +
      `focused set of clarifying questions about anything the code alone can't tell you — conventions, ` +
      `history, gotchas, who to loop in for what, anything you'd want to know before taking on real work.`,
    `Ask one question at a time and wait for a reply. When you have enough to work from, say so plainly ` +
      `and stop asking — do not pad the interview.`,
  ].join("\n\n")
}

function roleLabel(role: string): "User" | "Specialist" | undefined {
  if (role === "user") return "User"
  if (role === "assistant") return "Specialist"
  return undefined
}

/** Q&A transcript as plain text, oldest first — `role: 'tool'` and partial/empty
 *  messages are dropped, since neither carries anything worth teaching from. */
export function formatTeachingTranscript(messages: readonly SessionMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.partial) continue
    const label = roleLabel(message.role)
    if (!label) continue
    const content = message.content.trim()
    if (!content) continue
    lines.push(`${label}: ${content}`)
  }
  return lines.join("\n\n")
}

export interface RunTeachingPhaseOptions {
  /** Overrides `~/.{instance}/kb` — tests only. */
  kbRoot?: string
  embeddingModel?: string
  chunkOptions?: ChunkOptions
}

export interface RunTeachingPhaseResult {
  sessionId: string
  chunkCount: number
  transcriptChars: number
}

function teachingSourcePath(sessionId: string): string {
  return `teaching/${sessionId}.md`
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * Harvest a completed teaching session's transcript and store it as
 * `source: 'teaching'` chunks in the specialist's KB. A no-op (zero chunks,
 * nothing written) when the session has no usable user/assistant content —
 * e.g. the user skipped the teaching phase entirely.
 */
export async function runTeachingPhase(
  employee: TeachingEmployee,
  sessionId: string,
  options: RunTeachingPhaseOptions = {},
): Promise<RunTeachingPhaseResult> {
  const transcript = formatTeachingTranscript(getMessages(sessionId))
  if (!transcript) {
    logger.info(`knowledge-base/teaching: no transcript content for ${employee.name} session ${sessionId} — skipping`)
    return { sessionId, chunkCount: 0, transcriptChars: 0 }
  }

  const model = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
  const virtualPath = teachingSourcePath(sessionId)
  const chunks = chunkText(virtualPath, transcript, options.chunkOptions)
  const vectors = await embed(chunks.map((chunk) => chunk.text), { model })
  const inserts: ChunkInsert[] = chunks.map((chunk, i) => ({
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbolName: chunk.symbolName ?? null,
    text: chunk.text,
    contentHash: chunk.contentHash,
    source: "teaching",
    embedding: vectors[i],
  }))

  const db = initKbDb(employee.name, options.kbRoot)
  replaceFileChunks(db, virtualPath, inserts, { mtimeMs: Date.now(), contentHash: hashText(transcript) })

  logger.info(
    `knowledge-base/teaching: stored ${inserts.length} teaching chunk(s) for ${employee.name} from session ${sessionId}`,
  )
  return { sessionId, chunkCount: inserts.length, transcriptChars: transcript.length }
}
