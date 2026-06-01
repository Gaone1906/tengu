/**
 * Jinn Talk — in-process MCP tool server (Phase 2).
 *
 * Seven tools the /talk Agent-SDK turn can call. All tool calls are side-effect
 * free EXCEPT broadcasting a WS event via `deps.emit` (presentation tools) and
 * routing real work through `deps.org` (delegate / get_org_pulse). Tool results
 * are deliberately trivial acks — the spoken reply comes from the assistant's
 * streamed text, the detail goes on cards.
 *
 * Tool names surface to the model as `mcp__talk__<name>`.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { TALK_EVENTS } from "./protocol.js"
import type {
  Card,
  TalkCardEvent,
  TalkCardUpdateEvent,
  TalkCardDismissEvent,
  TalkCardClearEvent,
  TalkTaskEvent,
  TrackerTask,
} from "./protocol.js"
import type { TalkDeps } from "./context.js"

// ---------------------------------------------------------------------------
// Card id generation — monotonic counter + random suffix (no external dep).
// ---------------------------------------------------------------------------
let cardCounter = 0
function nextCardId(): string {
  cardCounter += 1
  return `card_${Date.now().toString(36)}_${cardCounter}_${Math.random().toString(36).slice(2, 6)}`
}

// ---------------------------------------------------------------------------
// Zod schemas — 1:1 mirror of protocol.ts `Card` discriminated union.
// CardBase fields (id?/title?/badge?) are spread into every variant; `id` is
// optional on input and backfilled by show_card when omitted.
// ---------------------------------------------------------------------------
const cardBase = {
  id: z.string().optional(),
  title: z.string().optional(),
  badge: z.string().optional(),
}

const jobStatus = z.enum(["queued", "running", "done", "error"])

const textCard = z.object({
  ...cardBase,
  type: z.literal("text"),
  body: z.string(),
  tldr: z.string().optional(),
})

const statCard = z.object({
  ...cardBase,
  type: z.literal("stat"),
  value: z.string(),
  label: z.string(),
  delta: z
    .object({
      dir: z.enum(["up", "down", "flat"]),
      value: z.string(),
    })
    .optional(),
})

const listCard = z.object({
  ...cardBase,
  type: z.literal("list"),
  ordered: z.boolean().optional(),
  items: z.array(
    z.object({
      text: z.string(),
      done: z.boolean().optional(),
    }),
  ),
})

const imageCard = z.object({
  ...cardBase,
  type: z.literal("image"),
  src: z.string(),
  alt: z.string().optional(),
  caption: z.string().optional(),
})

const imageGridCard = z.object({
  ...cardBase,
  type: z.literal("image-grid"),
  images: z.array(
    z.object({
      src: z.string(),
      alt: z.string().optional(),
    }),
  ),
})

const statusCard = z.object({
  ...cardBase,
  type: z.literal("status"),
  label: z.string(),
  progress: z.number(),
  state: jobStatus,
  chips: z.array(z.string()).optional(),
})

const agentActivityCard = z.object({
  ...cardBase,
  type: z.literal("agent-activity"),
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      status: jobStatus,
      detail: z.string().optional(),
      progress: z.number().optional(),
    }),
  ),
})

const linkCard = z.object({
  ...cardBase,
  type: z.literal("link"),
  url: z.string(),
  label: z.string(),
  source: z.string().optional(),
})

const cardSchema = z.discriminatedUnion("type", [
  textCard,
  statCard,
  listCard,
  imageCard,
  imageGridCard,
  statusCard,
  agentActivityCard,
  linkCard,
])

function ack(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

/**
 * Build the in-process MCP server exposing the 7 talk tools.
 */
export function createTalkMcpServer(deps: TalkDeps) {
  const { sessionId, emit, org, tts: _tts } = deps
  void _tts // TTS is driven by agent.ts, not the tools — kept for symmetry.

  return createSdkMcpServer({
    name: "talk",
    version: "0.2.0",
    tools: [
      // -------------------------------------------------------------- show_card
      tool(
        "show_card",
        "Display a content card on the visual surface beside the voice. Use this to show detail (stats, lists, links, images, agent activity) that would be tedious to speak. The spoken reply should stay short; cards carry the depth.",
        { card: cardSchema },
        async (args) => {
          const card = { ...args.card } as Card
          if (!card.id) card.id = nextCardId()
          const payload: TalkCardEvent = { sessionId, card }
          emit(TALK_EVENTS.card, payload)
          return ack(JSON.stringify({ cardId: card.id }))
        },
      ),

      // ------------------------------------------------------------ update_card
      tool(
        "update_card",
        "Patch an already-shown card in place by its id (e.g. flip a list item to done, bump a status progress). Pass only the fields that change.",
        {
          cardId: z.string(),
          patch: z.record(z.string(), z.unknown()),
        },
        async (args) => {
          const payload: TalkCardUpdateEvent = {
            sessionId,
            cardId: args.cardId,
            patch: args.patch as Partial<Card>,
          }
          emit(TALK_EVENTS.cardUpdate, payload)
          return ack(JSON.stringify({ cardId: args.cardId, updated: true }))
        },
      ),

      // ----------------------------------------------------------- dismiss_card
      tool(
        "dismiss_card",
        "Remove a single card from the surface by its id.",
        { cardId: z.string() },
        async (args) => {
          const payload: TalkCardDismissEvent = { sessionId, cardId: args.cardId }
          emit(TALK_EVENTS.cardDismiss, payload)
          return ack(JSON.stringify({ cardId: args.cardId, dismissed: true }))
        },
      ),

      // ---------------------------------------------------------- clear_surface
      tool(
        "clear_surface",
        "Clear every card from the visual surface. Use when changing topic.",
        {},
        async () => {
          const payload: TalkCardClearEvent = { sessionId }
          emit(TALK_EVENTS.cardClear, payload)
          return ack(JSON.stringify({ cleared: true }))
        },
      ),

      // --------------------------------------------------------------- set_task
      tool(
        "set_task",
        "Create or update a tracker task (the running-work strip). Reuse the same id to update an existing task's status/progress/result.",
        {
          id: z.string(),
          label: z.string(),
          owner: z.string(),
          status: jobStatus,
          progress: z.number().optional(),
          result: z.string().optional(),
        },
        async (args) => {
          const task: TrackerTask = {
            id: args.id,
            label: args.label,
            owner: args.owner,
            status: args.status,
            ...(args.progress !== undefined ? { progress: args.progress } : {}),
            ...(args.result !== undefined ? { result: args.result } : {}),
          }
          const payload: TalkTaskEvent = { sessionId, task }
          emit(TALK_EVENTS.task, payload)
          return ack(JSON.stringify({ taskId: task.id, status: task.status }))
        },
      ),

      // --------------------------------------------------------------- delegate
      tool(
        "delegate",
        "Delegate real work to the org. target 'coo' (default, Jimbo) or an employee name. async:true returns immediately with a task id and the work runs in the background (a tracker task updates as it progresses); async:false (default) blocks until the work finishes and returns the result for you to summarize aloud.",
        {
          task: z.string(),
          target: z.string().optional(),
          async: z.boolean().optional(),
        },
        async (args) => {
          const opts: { target?: string; async?: boolean } = {}
          if (args.target !== undefined) opts.target = args.target
          if (args.async !== undefined) opts.async = args.async
          const res = await org.delegate(args.task, opts, { sessionId, emit })
          if (!res.ok) {
            return ack(
              JSON.stringify({ ok: false, error: res.error ?? "delegation failed" }),
            )
          }
          if (opts.async) {
            return ack(
              JSON.stringify({
                ok: true,
                async: true,
                taskId: res.taskId,
                note: "Delegated and running in the background; the tracker task will update as it progresses.",
              }),
            )
          }
          return ack(
            JSON.stringify({ ok: true, result: res.result ?? "" }),
          )
        },
      ),

      // --------------------------------------------------------- get_org_pulse
      tool(
        "get_org_pulse",
        "Read-only snapshot of live org activity: who's working, running jobs, and anything awaiting approval. Read the `summary` aloud; optionally show_card the details.",
        {},
        async () => {
          const pulse = await org.getOrgPulse()
          return ack(JSON.stringify(pulse))
        },
      ),
    ],
  })
}
