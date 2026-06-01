/**
 * Jinn Talk — the streaming Agent-SDK turn (Phase 2).
 *
 * Runs one user utterance through the Claude Agent SDK on the Claude Code
 * subscription (no API key). The assistant's streamed TEXT is the spoken reply:
 * it is sentence-chunked for low latency, each sentence emitted as `talk:say`
 * and voiced through the Kokoro TTS sidecar in order. Detail goes on cards via
 * the in-process MCP tools (see tools.ts). State + lifecycle WS events bracket
 * the turn so the avatar can flip thinking → speaking → idle.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { TALK_EVENTS } from "./protocol.js"
import type { TalkStateEvent, TalkSayEvent, TalkTurnDoneEvent } from "./protocol.js"
import type { TalkDeps } from "./context.js"
import { createTalkMcpServer } from "./tools.js"

const MODEL = "claude-sonnet-4-6"

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

/**
 * Run a single /talk turn end to end.
 *
 * @param text  the user's transcribed utterance
 * @param deps  injected sessionId / emit / org bridge / TTS engine
 */
export async function runTalkTurn(
  text: string,
  deps: TalkDeps,
): Promise<{ ok: boolean; error?: string }> {
  const { sessionId, emit, tts } = deps

  const setState = (state: TalkStateEvent["state"]) => {
    const payload: TalkStateEvent = { sessionId, state }
    emit(TALK_EVENTS.state, payload)
  }

  let buffer = ""
  let spokenAny = false

  // Emit + voice one sentence, preserving order (awaited sequentially).
  const speak = async (sentence: string) => {
    const trimmed = sentence.trim()
    if (!trimmed) return
    if (!spokenAny) {
      spokenAny = true
      setState("speaking")
    }
    const sayPayload: TalkSayEvent = { sessionId, text: trimmed }
    emit(TALK_EVENTS.say, sayPayload)
    await tts.speak(sessionId, trimmed, emit)
  }

  let ok = true
  let error: string | undefined

  try {
    setState("thinking")

    const systemPrompt = loadSystemPrompt()
    const q = query({
      prompt: text,
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: 8,
        systemPrompt,
        mcpServers: { talk: createTalkMcpServer(deps) },
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
      },
    })

    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            buffer += block.text
            const { sentences, rest } = drainSentences(buffer)
            buffer = rest
            for (const s of sentences) {
              await speak(s)
            }
          }
          // tool_use blocks: the SDK runs the handler automatically (it emits
          // its own WS event). Nothing to do here.
        }
      } else if (msg.type === "result") {
        // Flush any buffered tail that never hit a sentence boundary.
        const tail = buffer.trim()
        buffer = ""
        if (tail) await speak(tail)
        if (msg.subtype !== "success" && !spokenAny) {
          // Surface a hard turn error if nothing was ever spoken.
          ok = false
          error =
            msg.subtype === "error_max_turns"
              ? "reached max turns"
              : "turn ended with an error"
        }
      }
    }

    // Safety net: flush anything still buffered (no result seen).
    const tail = buffer.trim()
    if (tail) await speak(tail)
  } catch (e) {
    ok = false
    error = e instanceof Error ? e.message : String(e)
  } finally {
    setState("idle")
    const donePayload: TalkTurnDoneEvent = error
      ? { sessionId, ok, error }
      : { sessionId, ok }
    emit(TALK_EVENTS.turnDone, donePayload)
  }

  return error ? { ok, error } : { ok }
}
