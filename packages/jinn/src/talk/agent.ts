/**
 * Jinn Talk — the streaming Agent-SDK turn (Phase 2).
 *
 * Runs user utterances through the Claude Agent SDK on the Claude Code
 * subscription (no API key). The assistant's streamed TEXT is the spoken reply:
 * it is sentence-chunked for low latency, each sentence emitted as `talk:say`
 * and voiced through the Kokoro TTS sidecar in order. Detail goes on cards via
 * the in-process MCP tools (see tools.ts). State + lifecycle WS events bracket
 * each turn so the avatar can flip thinking → speaking → idle.
 *
 * SPEED — persistent, pre-warmed session.
 *  - The SDK spawns a `claude` CLI subprocess on the FIRST input message and
 *    pays a one-time boot + system-prompt-processing cost (~5–10s). Calling
 *    `query()` per utterance made EVERY turn pay it.
 *  - Instead we keep ONE warm `query()` alive per talk `sessionId` via
 *    streaming-input mode: utterances are pushed into a live async generator and
 *    a single consumer loop demuxes the output per turn (each `result` ends a
 *    turn). Only the first turn pays boot; later turns are just Haiku's TTFT.
 *  - `warmTalkSession` pushes a SILENT priming turn on page-mount so that boot
 *    cost is paid in the background while the user reads the page — their first
 *    spoken turn is then warm too. Turns are queued (FIFO) so a real turn that
 *    lands during priming runs cleanly right after it.
 *  - Bonus: the session retains conversation context across turns.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { TALK_EVENTS } from "./protocol.js"
import type { TalkStateEvent, TalkSayEvent, TalkTurnDoneEvent } from "./protocol.js"
import type { TalkDeps } from "./context.js"
import { createTalkMcpServer } from "./tools.js"

// Haiku 4.5 on the Claude Code subscription ($0 metered). Chosen for low
// time-to-first-token: this layer is the *voice*, not the reasoner — real
// thinking happens downstream in the org via `delegate`. No thinking budget is
// configured, so Haiku answers immediately instead of pausing to reason (which
// would be dead air before the first spoken word).
const MODEL = "claude-haiku-4-5-20251001"

// Generous per-session agent-turn cap. Limits runaway tool loops without
// capping a normal conversation; if a turn ever hits it we recycle the session.
const MAX_TURNS = 100

// Close a warm session (and its CLI subprocess) after this much idle time so a
// long-abandoned tab doesn't keep a claude process pinned forever.
const IDLE_TTL_MS = 15 * 60 * 1000

// Silent priming utterance pushed by warmTalkSession. Forbids tools so the
// background warmup never renders a card, and asks for a 1-token reply so the
// cost is dominated by boot + system-prompt processing, not generation.
const PRIMING_PROMPT =
  "(System warmup ping — not from the user. Do NOT use any tools and do NOT greet. Reply with the single word: ready.)"

const ALLOWED_TOOLS = [
  "mcp__talk__show_card",
  "mcp__talk__update_card",
  "mcp__talk__dismiss_card",
  "mcp__talk__clear_surface",
  "mcp__talk__set_task",
  "mcp__talk__delegate",
  "mcp__talk__get_org_pulse",
]

const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Read",
  "Write",
  "WebFetch",
  "WebSearch",
  "Glob",
  "Grep",
  "Task",
  "NotebookEdit",
]

const INLINE_FALLBACK_PROMPT =
  "You are Jinn's terse, voice-first COO layer. Speak in short spoken sentences; push any real detail (stats, lists, links, agent status) onto cards via the talk tools rather than reading it all aloud."

/**
 * Load the system prompt markdown that ships next to this module. The build
 * step copies talk-system-prompt.md into dist; from source we fall back to the
 * src path, and finally to a short inline prompt so the turn never hard-fails.
 */
function loadSystemPrompt(): string {
  // 1. Next to the compiled/loaded module.
  try {
    const url = new URL("./talk-system-prompt.md", import.meta.url)
    return readFileSync(fileURLToPath(url), "utf8")
  } catch {
    // fall through
  }
  // 2. Source tree (running from dist before the .md is copied).
  try {
    const here = fileURLToPath(import.meta.url)
    const srcPath = here.replace("/dist/", "/src/")
    if (srcPath !== here) {
      const mdPath = srcPath.replace(/agent\.(js|ts)$/, "talk-system-prompt.md")
      return readFileSync(mdPath, "utf8")
    }
  } catch {
    // fall through
  }
  // 3. Inline fallback.
  return INLINE_FALLBACK_PROMPT
}

/** Sentence-boundary splitter for low-latency speaking. */
const SENTENCE_BOUNDARY = /([.!?\n]+)/

/**
 * Drain complete sentences out of a running buffer. Returns the sentences to
 * speak now and the remaining (incomplete) tail to keep buffering.
 */
function drainSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let working = buffer
  // Repeatedly peel off "<text><boundary>" prefixes.
  for (;;) {
    const m = working.match(SENTENCE_BOUNDARY)
    if (!m || m.index === undefined) break
    const end = m.index + m[0].length
    const chunk = working.slice(0, end).trim()
    if (chunk) sentences.push(chunk)
    working = working.slice(end)
  }
  return { sentences, rest: working }
}

type TurnResult = { ok: boolean; error?: string }

/** Mutable per-turn state, recreated for each utterance pushed into a session. */
interface PerTurn {
  text: string
  /** A background warmup turn: consume + discard output, emit no WS events. */
  silent: boolean
  buffer: string
  spokenAny: boolean
  queuedAny: boolean
  /** Serializes TTS so speaking stays ordered without blocking the reader. */
  voiceChain: Promise<void>
  resolve: (r: TurnResult) => void
  settled: boolean
}

/** A warm Agent-SDK session bound to one talk sessionId. */
interface TalkSession {
  /** Push one utterance and resolve when its turn completes. */
  push: (text: string) => Promise<TurnResult>
  /** Push a silent background warmup turn (boots the subprocess). */
  prime: () => void
  /** Tear the session + subprocess down. */
  close: () => void
}

const SESSIONS = new Map<string, TalkSession>()

/**
 * Build a persistent, warm Agent-SDK session for one talk sessionId. The first
 * turn pays the CLI subprocess boot; subsequent ones are warm.
 */
function createSession(deps: TalkDeps): TalkSession {
  const { sessionId, emit, tts } = deps

  const setState = (state: TalkStateEvent["state"]) => {
    const payload: TalkStateEvent = { sessionId, state }
    emit(TALK_EVENTS.state, payload)
  }

  // ── streaming input: a generator the SDK pulls user messages from ──────────
  const inbox: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  let closed = false

  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      if (inbox.length) {
        yield inbox.shift() as SDKUserMessage
        continue
      }
      await new Promise<void>((r) => (wake = r))
    }
  }

  // ── turn queue (FIFO; head = active). Mirrors the SDK's in-order results. ──
  const turns: PerTurn[] = []
  let primed = false // prime once per session lifetime (repeated reloads no-op)

  // ── voice pipeline (bound to this session's deps) ──────────────────────────
  const speak = async (turn: PerTurn, sentence: string) => {
    const trimmed = sentence.trim()
    if (!trimmed) return
    if (!turn.spokenAny) {
      turn.spokenAny = true
      setState("speaking")
    }
    const sayPayload: TalkSayEvent = { sessionId, text: trimmed }
    emit(TALK_EVENTS.say, sayPayload)
    await tts.speak(sessionId, trimmed, emit)
  }

  // Queue a sentence after all previously-queued ones, WITHOUT blocking the
  // model-stream reader. Order (say + audio) is preserved by the chain.
  const enqueueSpeak = (turn: PerTurn, sentence: string) => {
    const trimmed = sentence.trim()
    if (!trimmed) return
    turn.queuedAny = true
    turn.voiceChain = turn.voiceChain.then(() => speak(turn, trimmed))
  }

  // ── idle TTL ───────────────────────────────────────────────────────────────
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => close(), IDLE_TTL_MS)
    idleTimer.unref?.() // don't keep the event loop alive for the reaper
  }

  /** Called when a turn becomes the head of the queue (starts processing). */
  const activate = (turn: PerTurn) => {
    if (!turn.silent) setState("thinking")
  }

  const finishTurn = (turn: PerTurn, res: TurnResult) => {
    if (turn.settled) return
    turn.settled = true
    if (!turn.silent) {
      setState("idle")
      const done: TalkTurnDoneEvent = res.error
        ? { sessionId, ok: res.ok, error: res.error }
        : { sessionId, ok: res.ok }
      emit(TALK_EVENTS.turnDone, done)
    }
    const idx = turns.indexOf(turn)
    if (idx >= 0) turns.splice(idx, 1)
    armIdle()
    turn.resolve(res)
    const next = turns[0]
    if (next) activate(next)
  }

  const q = query({
    prompt: input(),
    options: {
      model: MODEL,
      permissionMode: "bypassPermissions",
      maxTurns: MAX_TURNS,
      systemPrompt: loadSystemPrompt(),
      mcpServers: { talk: createTalkMcpServer(deps) },
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
    },
  })

  function close(): void {
    if (closed) return
    closed = true
    if (idleTimer) clearTimeout(idleTimer)
    if (wake) {
      wake()
      wake = null
    }
    try {
      q.close()
    } catch {
      // already gone
    }
    if (SESSIONS.get(sessionId) === session) SESSIONS.delete(sessionId)
    // Fail any queued turns so their callers don't hang.
    for (const turn of [...turns]) {
      if (!turn.settled) {
        turn.settled = true
        turn.resolve({ ok: false, error: "session closed" })
      }
    }
    turns.length = 0
  }

  // ── single consumer loop: demux output to the head of the queue ────────────
  ;(async () => {
    try {
      for await (const msg of q) {
        const turn = turns[0]
        if (!turn) continue // between turns (shouldn't happen; turns are serial)

        if (msg.type === "assistant") {
          if (turn.silent) continue // discard warmup output entirely
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              turn.buffer += block.text
              const { sentences, rest } = drainSentences(turn.buffer)
              turn.buffer = rest
              for (const s of sentences) enqueueSpeak(turn, s)
            }
            // tool_use blocks: the in-process MCP handler runs automatically and
            // emits its own WS event. Nothing to do here.
          }
        } else if (msg.type === "result") {
          const maxedOut = msg.subtype === "error_max_turns"
          if (turn.silent) {
            finishTurn(turn, { ok: true })
            if (maxedOut) close()
            continue
          }
          // Flush the buffered tail that never hit a sentence boundary.
          const tail = turn.buffer.trim()
          turn.buffer = ""
          if (tail) enqueueSpeak(turn, tail)
          // Wait for all queued speech to finish before settling to idle.
          await turn.voiceChain
          const ok = msg.subtype === "success" || turn.queuedAny
          const error = ok
            ? undefined
            : maxedOut
              ? "reached max turns"
              : "turn ended with an error"
          finishTurn(turn, error ? { ok, error } : { ok })
          // If we hit the per-session turn cap, recycle so the next utterance
          // starts a fresh session rather than erroring forever.
          if (maxedOut) close()
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      const head = turns[0]
      if (head) finishTurn(head, { ok: false, error })
      close()
    }
  })()

  const enqueueTurn = (turn: PerTurn) => {
    const wasEmpty = turns.length === 0
    turns.push(turn)
    inbox.push({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: turn.text },
    } as SDKUserMessage)
    if (wake) {
      wake()
      wake = null
    }
    if (wasEmpty) activate(turn)
  }

  const makeTurn = (text: string, silent: boolean, resolve: (r: TurnResult) => void): PerTurn => ({
    text,
    silent,
    buffer: "",
    spokenAny: false,
    queuedAny: false,
    voiceChain: Promise.resolve(),
    resolve,
    settled: false,
  })

  const push = (text: string): Promise<TurnResult> =>
    new Promise<TurnResult>((resolve) => {
      if (closed) {
        resolve({ ok: false, error: "session closed" })
        return
      }
      enqueueTurn(makeTurn(text, false, resolve))
    })

  const prime = (): void => {
    if (closed || primed) return
    // Only prime an empty session — pointless if turns are already flowing.
    if (turns.length > 0) return
    primed = true
    enqueueTurn(makeTurn(PRIMING_PROMPT, true, () => {}))
  }

  const session: TalkSession = { push, prime, close }
  armIdle()
  return session
}

/**
 * Pre-boot the warm session (and its CLI subprocess) for `deps.sessionId` by
 * running a SILENT priming turn. Called when the /talk page connects so the
 * user's first real turn is already warm instead of paying the cold boot.
 * Idempotent and fire-and-forget.
 */
export function warmTalkSession(deps: TalkDeps): void {
  let session = SESSIONS.get(deps.sessionId)
  if (!session) {
    session = createSession(deps)
    SESSIONS.set(deps.sessionId, session)
  }
  session.prime()
  // Also pre-load the TTS model so the first spoken sentence's audio is snappy
  // (the silent priming turn never calls speak(), so Kokoro stays cold otherwise).
  void deps.tts.warm?.()
}

/**
 * Run a single /talk turn end to end, reusing (or lazily creating) the warm
 * session for `deps.sessionId`.
 *
 * @param text  the user's transcribed utterance
 * @param deps  injected sessionId / emit / org bridge / TTS engine
 */
export async function runTalkTurn(
  text: string,
  deps: TalkDeps,
): Promise<{ ok: boolean; error?: string }> {
  let session = SESSIONS.get(deps.sessionId)
  if (!session) {
    session = createSession(deps)
    SESSIONS.set(deps.sessionId, session)
  }
  try {
    return await session.push(text)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
