import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@/lib/conversations'
import { parseMedia, stripAttachedFilesBlock } from '@/lib/conversations'
import { MessageMedia } from './message-media'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'
import { useMessageTts, stopMessageTts } from './use-message-tts'
import { ChatBlockInline, statusMark } from './chat-blocks'
import { blockFallbackContent, isActiveDelegationStatus, type LiveBlockArrival } from '@/lib/blocks'
import { ChevronDown, FileText, Globe, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react'
import { parseTeammateReply, TeammateReply } from './teammate-reply'
import { parseAgentRelay, AgentRelay } from './agent-relay'
import { DispatchRow } from './dispatch-row'
import { BURST_WINDOW_MS, CallbackBurst, type BurstEntry } from './callback-burst'
import { FoldRegion, type FoldSummaryData } from './fold-region'
import type { CommsPeekData } from './thread-peek'
import { TodoActivityBurst } from './todo-activity-burst'
import { formatMessage } from './message-markdown'

export { formatMessage, isFilePath, parseFenceLang } from './message-markdown'

/* ── Tool grouping ──────────────────────────────────────── */

type MessageItem =
  | { kind: 'message'; msg: Message; index: number }
  | { kind: 'tool-group'; msgs: Message[]; startIndex: number }
  | { kind: 'dispatch-call'; msg: Message; index: number }
  | { kind: 'callback-burst'; entries: BurstEntry[]; startIndex: number }
  | { kind: 'todo-burst'; msgs: Message[]; startIndex: number; endIndex: number }

// A finished tool call lands in the transcript as "Used <tool>". While it's
// still running the content carries the live tool name instead.
function isToolDone(msg: Message): boolean {
  return msg.content.startsWith('Used ')
}

function findActiveToolIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isToolDone(msgs[i])) return i
  }
  return -1
}

const TOOL_GLYPH_RULES: ReadonlyArray<{
  glyph: LucideIcon
  matches: readonly string[]
}> = [
  { glyph: FileText, matches: ['read', 'write', 'edit', 'file', 'patch', 'notebook'] },
  { glyph: Terminal, matches: ['bash', 'shell', 'exec', 'run', 'command'] },
  { glyph: Search, matches: ['grep', 'glob', 'search', 'find'] },
  { glyph: Globe, matches: ['fetch', 'web', 'browser', 'http'] },
]

export function toolGlyphForName(toolName: string): LucideIcon {
  const normalized = toolName.replace(/^mcp__.*?__/i, '').toLowerCase()
  return TOOL_GLYPH_RULES.find(({ matches }) => matches.some((match) => normalized.includes(match)))?.glyph
    ?? Wrench
}

function isDelegationToolCall(msg: Message): boolean {
  const name = msg.toolCall || ''
  return name === 'delegate_task' || name.endsWith('__delegate_task')
}

// A follow-up sent into another session (usually a delegated child). Surfaced
// as a distinct dispatch row rather than buried in the tool pile — but only in
// its generic form: the transcript's tool call carries no target or text. Once
// the gateway emits `dispatch` blocks (structured contract), those take over
// and the raw tool calls are skipped like delegation ones.
function isDispatchToolCall(msg: Message): boolean {
  const name = msg.toolCall || ''
  return name === 'send_to_session' || name.endsWith('__send_to_session')
}

const ACTIVITY_BLOCK_TYPES = new Set(['todo-activity', 'workflow-definition', 'workflow-run'])

// A completed generic tool row is redundant once its server-authored activity
// object is present in the thread. Suppress it deterministically:
//  · exact — the tool row's meta.activityReceiptId equals a present activity
//    block id (the correlated, reload-safe path);
//  · legacy — for reloads produced before correlation metadata existed, within
//    ONE user turn, suppress exactly one completed row when exactly one unmatched
//    activity block in that turn declares that tool name and exactly one completed
//    row carries it. Never an active tool, an error/read-only row (no receipt), a
//    row in another turn, or an ambiguous cardinality.
function suppressedActivityToolIds(messages: Message[]): Set<string> {
  const suppressed = new Set<string>()
  const presentBlockIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (ACTIVITY_BLOCK_TYPES.has(block.type)) presentBlockIds.add(block.id)
    }
  }
  if (presentBlockIds.size === 0) return suppressed

  const matchedBlockIds = new Set<string>()
  for (const message of messages) {
    if (!message.toolCall || !isToolDone(message) || !message.id) continue
    const receiptId = message.meta?.activityReceiptId
    if (typeof receiptId === 'string' && presentBlockIds.has(receiptId)) {
      suppressed.add(message.id)
      matchedBlockIds.add(receiptId)
    }
  }

  // Legacy 1:1 fallback, partitioned by user turn.
  let turnStart = 0
  const flushTurn = (start: number, end: number) => {
    const blockNames = new Map<string, number>()
    const rowsByName = new Map<string, Message[]>()
    for (let i = start; i < end; i++) {
      const message = messages[i]
      for (const block of message.blocks ?? []) {
        if (!ACTIVITY_BLOCK_TYPES.has(block.type) || matchedBlockIds.has(block.id)) continue
        const receipt = block.payload?.activityReceipt as { toolName?: unknown } | undefined
        const toolName = typeof receipt?.toolName === 'string' ? receipt.toolName : ''
        if (toolName) blockNames.set(toolName, (blockNames.get(toolName) ?? 0) + 1)
      }
      if (message.toolCall && isToolDone(message) && message.id
        && !suppressed.has(message.id) && message.meta?.activityReceiptId === undefined) {
        const list = rowsByName.get(message.toolCall) ?? []
        list.push(message)
        rowsByName.set(message.toolCall, list)
      }
    }
    for (const [name, count] of blockNames) {
      const rows = rowsByName.get(name)
      if (count === 1 && rows && rows.length === 1 && rows[0].id) suppressed.add(rows[0].id)
    }
  }
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && i > turnStart) {
      flushTurn(turnStart, i)
      turnStart = i
    }
  }
  flushTurn(turnStart, messages.length)

  return suppressed
}

function createdTodoRootId(item: MessageItem): string | null {
  if (item.kind !== 'message' || item.msg.role !== 'assistant' || item.msg.toolCall) return null
  const blocks = item.msg.blocks ?? []
  if (blocks.length !== 1 || blocks[0].type !== 'todo-activity') return null
  const block = blocks[0]
  return block.payload.action === 'created' && typeof block.payload.rootId === 'string' && block.payload.rootId
    ? block.payload.rootId
    : null
}

function groupTodoCreationBursts(items: MessageItem[]): MessageItem[] {
  const grouped: MessageItem[] = []
  let i = 0
  while (i < items.length) {
    const rootId = createdTodoRootId(items[i])
    if (!rootId) {
      grouped.push(items[i])
      i++
      continue
    }
    const start = i
    const msgs: Message[] = []
    while (i < items.length && createdTodoRootId(items[i]) === rootId) {
      const item = items[i]
      if (item.kind !== 'message') break
      msgs.push(item.msg)
      i++
    }
    if (msgs.length >= 2) {
      const first = items[start]
      const last = items[i - 1]
      grouped.push({
        kind: 'todo-burst',
        msgs,
        startIndex: first.kind === 'message' ? first.index : start,
        endIndex: last.kind === 'message' ? last.index : i - 1,
      })
    } else {
      grouped.push(items[start])
    }
  }
  return grouped
}

export function groupMessages(messages: Message[]): MessageItem[] {
  const items: MessageItem[] = []
  const suppressedToolIds = suppressedActivityToolIds(messages)
  const hasDelegationBlock = messages.some((message) =>
    message.blocks?.some((block) => block.type === 'delegation'),
  )
  const hasDispatchBlock = messages.some((message) =>
    message.blocks?.some((block) => block.type === 'dispatch'),
  )
  let i = 0
  while (i < messages.length) {
    if (hasDelegationBlock && messages[i].role === 'assistant' && messages[i].toolCall && isDelegationToolCall(messages[i])) {
      i++
      continue
    }
    if (messages[i].role === 'assistant' && messages[i].toolCall && isDispatchToolCall(messages[i])) {
      if (!hasDispatchBlock) items.push({ kind: 'dispatch-call', msg: messages[i], index: i })
      i++
      continue
    }
    if (messages[i].role === 'assistant' && messages[i].toolCall) {
      const toolMsgs: Message[] = []
      const start = i
      while (
        i < messages.length && messages[i].role === 'assistant' && messages[i].toolCall
        && !isDispatchToolCall(messages[i])
      ) {
        const suppressedByReceipt = Boolean(messages[i].id && suppressedToolIds.has(messages[i].id as string))
        if ((!hasDelegationBlock || !isDelegationToolCall(messages[i])) && !suppressedByReceipt) {
          toolMsgs.push(messages[i])
        }
        i++
      }
      if (toolMsgs.length > 0) items.push({ kind: 'tool-group', msgs: toolMsgs, startIndex: start })
    } else {
      // T3 burst grouping: 2+ consecutive callbacks landing within the burst
      // window compose into ONE grouped entry — the pile gets quieter as it
      // grows instead of louder.
      const callback = messages[i].role === 'notification' ? parseTeammateReply(messages[i]) : null
      if (callback) {
        const start = i
        const entries: BurstEntry[] = [{ data: callback, msg: messages[i], messageId: messages[i].id || `idx-${i}` }]
        i++
        while (i < messages.length && messages[i].role === 'notification') {
          if (messages[i].timestamp - messages[i - 1].timestamp > BURST_WINDOW_MS) break
          const next = parseTeammateReply(messages[i])
          if (!next) break
          entries.push({ data: next, msg: messages[i], messageId: messages[i].id || `idx-${i}` })
          i++
        }
        if (entries.length >= 2) {
          items.push({ kind: 'callback-burst', entries, startIndex: start })
        } else {
          items.push({ kind: 'message', msg: messages[start], index: start })
        }
        continue
      }
      items.push({ kind: 'message', msg: messages[i], index: i })
      i++
    }
  }
  return groupTodoCreationBursts(items)
}

/* ── The post-turn fold — partitioning ──────────────────── */

/** The turn's final answer: an assistant prose message. Tool calls are not
 *  answers, and neither is any block-carrying message — blocks render as
 *  cards/objects (handoffs, dispatches, task lists), not the turn's prose.
 *  Conservative on purpose: when in doubt the evidence stays visible. */
function isAnswerMessage(msg: Message): boolean {
  if (msg.role !== 'assistant' || msg.toolCall) return false
  if (msg.blocks?.length) return false
  return Boolean((msg.content || '').trim())
}

/** A centered bell banner: a notification that is neither a callback nor a
 *  relay. Banners stay OUTSIDE the fold (they're addressed to the user, not
 *  part of the model's work) — a mid-turn banner splits the region. */
function isSystemBanner(msg: Message): boolean {
  return msg.role === 'notification' && !parseTeammateReply(msg) && !parseAgentRelay(msg)
}

function messageMedia(msg: Message) {
  return msg.media?.length ? msg.media : parseMedia(msg.content)
}

function itemHasAssistantMedia(item: MessageItem): boolean {
  const messages = item.kind === 'tool-group' || item.kind === 'todo-burst'
    ? item.msgs
    : item.kind === 'callback-burst'
      ? item.entries.map((entry) => entry.msg)
      : [item.msg]
  return messages.some((message) => message.role === 'assistant' && messageMedia(message).length > 0)
}

/** A child callback ("dev replied") or an agent relay ("From dev [hop N]"): an
 *  injected notification that RE-INVOKES the model, starting a fresh engine turn
 *  inside the same logical (user) turn. It closes the previous segment so the
 *  earlier reply stays visible, and folds into the engine turn it triggers. */
function isReinvocationBoundary(msg: Message): boolean {
  return msg.role === 'notification' && Boolean(parseTeammateReply(msg) || parseAgentRelay(msg))
}

/**
 * For each raw message index, the index of the answer that closes ITS engine-turn
 * segment — the last non-partial assistant prose message in the run of work that
 * ends at the next user message OR the next child re-invocation (callback/relay).
 * -1 while that segment has produced no answer yet.
 *
 * One logical (user) turn can hold several engine turns: the model replies and
 * stops, a child callback re-invokes it, it replies again. Each engine turn keeps
 * its OWN closing answer, so the fold before it is scoped to just that segment's
 * work — the earlier reply and its "Worked for" fold are preserved rather than
 * swallowed by one region reaching the turn's very last block. Interim prose
 * WITHIN one engine turn still folds; only the segment's last answer is a boundary.
 * Exported for tests.
 */
export function finalAnswerIndices(messages: Message[]): number[] {
  const out = new Array<number>(messages.length).fill(-1)
  let nextReply = -1
  // After a re-invocation boundary the NEXT prose above it closes a fresh
  // segment — a preserved reply. But a segment that produced NO prose (pure tool
  // work before a callback) must keep folding toward the downstream reply, so we
  // only re-point `nextReply` when that armed prose actually appears; tools-only
  // work therefore stays in one fold instead of orphaning as bare rows.
  let armed = false
  for (let j = messages.length - 1; j >= 0; j--) {
    if (messages[j].role === 'user') {
      nextReply = -1
      armed = false
      out[j] = -1
      continue
    }
    if (isReinvocationBoundary(messages[j])) {
      // The trigger folds into the engine turn it started (the segment below),
      // and arms the next prose above it as that turn's preserved reply.
      out[j] = nextReply
      armed = true
      continue
    }
    // A restored `partial` prose row is still middle evidence. The first
    // non-partial prose after a boundary (or the turn's first) is a preserved
    // reply; later prose in the same engine turn is interim and folds toward it.
    if (!messages[j].partial && isAnswerMessage(messages[j]) && (nextReply === -1 || armed)) {
      nextReply = j
      armed = false
    }
    out[j] = nextReply
  }
  return out
}

function itemFirstMsg(item: MessageItem): Message {
  if (item.kind === 'tool-group' || item.kind === 'todo-burst') return item.msgs[0]
  if (item.kind === 'callback-burst') return item.entries[0].msg
  return item.msg
}

function itemLastMsg(item: MessageItem): Message {
  if (item.kind === 'tool-group' || item.kind === 'todo-burst') return item.msgs[item.msgs.length - 1]
  if (item.kind === 'callback-burst') return item.entries[item.entries.length - 1].msg
  return item.msg
}

function itemFirstRawIndex(item: MessageItem): number {
  if (item.kind === 'tool-group' || item.kind === 'callback-burst' || item.kind === 'todo-burst') return item.startIndex
  return item.index
}

function itemLastRawIndex(item: MessageItem): number {
  if (item.kind === 'tool-group') return item.startIndex + item.msgs.length - 1
  if (item.kind === 'todo-burst') return item.endIndex
  if (item.kind === 'callback-burst') return item.startIndex + item.entries.length - 1
  return item.index
}

function itemHasActiveDelegation(item: MessageItem): boolean {
  const rows = item.kind === 'tool-group' || item.kind === 'todo-burst'
    ? item.msgs
    : item.kind === 'callback-burst'
      ? item.entries.map((entry) => entry.msg)
      : [item.msg]
  return rows.some((message) => message.blocks?.some((block) =>
    block.type === 'delegation' && isActiveDelegationStatus(block.status),
  ))
}

function validTimestamp(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Locate the durable start of the engine segment closed by `answerIndex`.
 * The initiating user starts the first segment. After a completed reply, a
 * callback/relay starts the next one; callbacks that arrive before any reply
 * remain evidence inside the still-open initial segment. */
function settledSegmentStartIndex(messages: Message[], answerIndex: number): number {
  let userIndex = -1
  for (let index = answerIndex - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      userIndex = index
      break
    }
  }

  let startIndex = userIndex
  let completedReply = false
  for (let index = userIndex + 1; index < answerIndex; index++) {
    const message = messages[index]
    if (isReinvocationBoundary(message)) {
      if (completedReply) {
        startIndex = index
        completedReply = false
      }
      continue
    }
    if (!message.partial && isAnswerMessage(message)) completedReply = true
  }
  return startIndex
}

/** A settled fold measures one durable engine segment: initiating user or
 * callback/relay boundary → canonical final assistant row. Legacy rows may lack
 * one boundary; in that case, recover only from timestamped evidence inside
 * the same segment. A single evidence row cannot establish an interval. */
function settledDurationMs(messages: Message[], answerIndex: number): number | null {
  if (answerIndex < 0 || answerIndex >= messages.length) return null

  const segmentStartIndex = settledSegmentStartIndex(messages, answerIndex)
  let startIndex = segmentStartIndex
  let start = segmentStartIndex >= 0 ? validTimestamp(messages[segmentStartIndex].timestamp) : null
  if (start === null) {
    startIndex = -1
    for (let index = segmentStartIndex + 1; index < answerIndex; index++) {
      const timestamp = validTimestamp(messages[index].timestamp)
      if (timestamp === null) continue
      start = timestamp
      startIndex = index
      break
    }
  }

  let endIndex = answerIndex
  let end = validTimestamp(messages[answerIndex].timestamp)
  if (end === null) {
    endIndex = -1
    for (let index = answerIndex - 1; index > segmentStartIndex; index--) {
      const timestamp = validTimestamp(messages[index].timestamp)
      if (timestamp === null) continue
      end = timestamp
      endIndex = index
      break
    }
  }

  if (start === null || end === null || startIndex === endIndex || end < start) return null
  return end - start
}

export function buildFoldSummary(run: MessageItem[], messages: Message[], answerIndex: number): FoldSummaryData {
  let tools = 0
  let updates = 0
  const teammates = new Set<string>()
  for (const item of run) {
    if (item.kind === 'tool-group') {
      tools += item.msgs.length
      continue
    }
    if (item.kind === 'dispatch-call') {
      tools += 1
      continue
    }
    if (item.kind === 'callback-burst') {
      for (const entry of item.entries) {
        teammates.add(entry.data.employee)
      }
      continue
    }
    if (item.kind === 'todo-burst') continue
    const msg = item.msg
    if (msg.role === 'notification') {
      const callback = parseTeammateReply(msg)
      if (callback) {
        teammates.add(callback.employee)
        continue
      }
      const relay = parseAgentRelay(msg)
      if (relay) {
        teammates.add(relay.fromLabel)
      }
      continue
    }
    // Interim prose the model wrote on the way to the answer.
    if (isAnswerMessage(msg) && messageMedia(msg).length === 0) updates += 1
    for (const block of msg.blocks || []) {
      const employee = block.payload?.employee
      if (typeof employee === 'string' && employee) {
        teammates.add(employee)
      }
    }
  }
  return { durationMs: settledDurationMs(messages, answerIndex), tools, teammates: teammates.size, updates }
}

type RenderGroup =
  | { kind: 'plain'; item: MessageItem }
  | { kind: 'fold'; id: string; items: MessageItem[]; answered: boolean; liveCompletion: boolean; collapseRequested: boolean; summary: FoldSummaryData; answerIdx: number; animated: boolean }

export function shouldFoldAfterNextAsk(messages: Message[], answerIndex: number): boolean {
  return answerIndex >= 0 && messages.slice(answerIndex + 1).some((message) => message.role === 'user')
}

export function partitionForFold(
  items: MessageItem[],
  messages: Message[],
  incompleteTurnIds: ReadonlySet<string>,
  liveFinalResponseId: string | null,
  liveTerminalDelegationIds: ReadonlySet<string>,
): RenderGroup[] {
  const answerIdx = finalAnswerIndices(messages)

  const turnIdFor = (rawIndex: number): string => {
    for (let j = rawIndex; j >= 0; j--) {
      if (messages[j].role === 'user') return messages[j].id || `t${j}`
    }
    return 'head'
  }

  // A fold wraps the work leading up to each visible answer: tool calls,
  // interim prose, the triggering callbacks/relays, delegation and dispatch
  // rows BEFORE that segment's answer. The answer stays outside, and the work
  // after it opens a NEW fold — so one logical turn can hold several
  // (fold → visible reply) segments (reply, child re-invoke, reply again).
  // System banners and media-bearing assistant rows stay outside too; either
  // one splits a mid-turn region without orphaning the work around it.
  const folds = (item: MessageItem): boolean => {
    const msg = itemFirstMsg(item)
    if (msg.role === 'user') return false
    if (item.kind === 'message' && isSystemBanner(item.msg)) return false
    if (itemHasAssistantMedia(item)) return false
    if (itemHasActiveDelegation(item)) return false
    if (incompleteTurnIds.has(turnIdFor(itemFirstRawIndex(item)))) return false
    const answer = answerIdx[itemFirstRawIndex(item)]
    // No true final answer means no fold DOM at all: active evidence renders in
    // the ordinary stream until completion creates the completed-turn region.
    if (answer === -1) return false
    return itemLastRawIndex(item) < answer
  }

  const groups: RenderGroup[] = []
  const turnSeq = new Map<string, number>()
  let i = 0
  while (i < items.length) {
    if (!folds(items[i])) {
      groups.push({ kind: 'plain', item: items[i] })
      i++
      continue
    }
    // Consecutive foldable items form one region. A run never crosses a
    // segment boundary by construction: the user message, each segment's
    // answer, and any interim reply are all non-foldable, so they break it.
    const run: MessageItem[] = []
    while (i < items.length && folds(items[i])) {
      run.push(items[i])
      i++
    }
    const answer = answerIdx[itemFirstRawIndex(run[0])]
    const answered = answer !== -1
    // Region identity is TURN-scoped with a per-turn sequence, never
    // first-item-scoped: a turn can hold several folds (one before each
    // answer), and streaming can grow a run's first evidence row — a
    // first-item key would remount the region as a fresh instance resting
    // folded, snap-collapsing the middle instead of playing the anchored fold.
    // The (anchorId, seq) pair keeps each fold stable across those changes.
    let turnAnchor = -1
    for (let j = itemFirstRawIndex(run[0]); j >= 0; j--) {
      if (messages[j].role === 'user') {
        turnAnchor = j
        break
      }
    }
    const anchorId = turnAnchor >= 0 ? (messages[turnAnchor].id || `t${turnAnchor}`) : 'head'
    const seq = turnSeq.get(anchorId) ?? 0
    turnSeq.set(anchorId, seq + 1)
    groups.push({
      kind: 'fold',
      id: `${anchorId}-${seq}`,
      items: run,
      answered,
      liveCompletion: messages[answer]?.id === liveFinalResponseId || run.some((item) => {
        const rows = item.kind === 'tool-group' || item.kind === 'todo-burst'
          ? item.msgs
          : item.kind === 'callback-burst'
            ? item.entries.map((entry) => entry.msg)
            : [item.msg]
        return rows.some((message) => message.blocks?.some((block) => liveTerminalDelegationIds.has(block.id)))
      }),
      collapseRequested: shouldFoldAfterNextAsk(messages, answer),
      summary: buildFoldSummary(run, messages, answer),
      answerIdx: answer,
      animated: true,
    })
  }
  // When an exempt row splits one turn into several regions they all answer at
  // the same instant — per-region scroll anchoring would double-compensate the
  // shared scroller. Only the region nearest the answer owns the settled
  // duration and plays the anchored choreography; earlier siblings fold with
  // the instant path.
  const seenAnswers = new Set<number>()
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]
    if (group.kind !== 'fold' || group.answerIdx === -1) continue
    if (seenAnswers.has(group.answerIdx)) {
      group.animated = false
      group.summary = { ...group.summary, durationMs: null }
    }
    seenAnswers.add(group.answerIdx)
  }
  return groups
}

function ToolGroup({
  msgs,
  isActive,
}: {
  msgs: Message[]
  isActive: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [showAllTools, setShowAllTools] = useState(false)
  const allDone = msgs.every(isToolDone)
  const activeIndex = isActive ? findActiveToolIndex(msgs) : -1
  const label = isActive && !allDone
    ? `${msgs.length} tool${msgs.length !== 1 ? 's' : ''} running…`
    : `${msgs.length} tool${msgs.length !== 1 ? 's' : ''}`
  const indexedMsgs = msgs.map((msg, index) => ({ msg, index }))
  const activeEntry = activeIndex >= 10 ? indexedMsgs[activeIndex] : undefined
  const visibleEntries = showAllTools
    ? indexedMsgs
    : activeEntry
      ? [...indexedMsgs.slice(0, 9), activeEntry]
      : indexedMsgs.slice(0, 10)
  const hiddenToolCount = Math.max(0, msgs.length - visibleEntries.length)

  return (
    // Share the assistant text gutter (.assistant-msg-row → space-3 / space-8 @lg)
    // so the tool card's left edge lines up with the message text column.
    <div className="assistant-msg-row mb-[var(--space-1)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border-none bg-[var(--fill-quaternary)] py-1 pl-3 pr-2.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)] shadow-none transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.97]"
      >
        <Wrench size={13} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="min-w-0 truncate font-[var(--weight-medium)]">{label}</span>
        {isActive && !allDone && (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite]" />
        )}
        <ChevronDown size={14} className={`ml-0.5 shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 ease-[var(--ease-smooth)] ${expanded ? 'rotate-180' : 'rotate-0'}`} />
      </button>
      {expanded && (
        <div
          className="mt-1.5 flex max-w-[min(620px,calc(100vw_-_var(--space-6)))] flex-col items-start gap-1 pl-1"
          data-testid="tool-group-list"
        >
          {visibleEntries.map(({ msg: m, index }) => {
            const done = isToolDone(m)
            const key = m.id || `${m.toolCall}-${index}`
            const status = done ? 'done' : index === activeIndex ? 'running' : 'queued'
            const ToolGlyph = toolGlyphForName(m.toolCall || '')
            return (
              <div
                key={key}
                className="inline-flex min-h-9 max-w-full items-center gap-1.5 px-2.5 py-1 text-left"
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {statusMark(status)}
                </span>
                <ToolGlyph size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="min-w-0 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
                  {m.toolCall || `Tool ${index + 1}`}
                </span>
              </div>
            )
          })}
          {hiddenToolCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllTools(true)}
              className="ml-6 inline-flex min-h-8 items-center gap-1 rounded-full border-none bg-transparent px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-[background-color,color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)] active:scale-[0.96]"
            >
              Show {hiddenToolCount} more
              <ChevronDown size={13} className="shrink-0 text-[var(--text-quaternary)]" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Partial markdown fixer for streaming ───────────────── */

/**
 * Close unclosed markdown tokens so partial content renders cleanly.
 * Handles: code blocks (```), inline code (`), bold (**), italic (*).
 */
function closePartialMarkdown(text: string): string {
  let result = text

  // Count triple backticks — if odd, close the code block
  const tripleBackticks = (result.match(/```/g) || []).length
  if (tripleBackticks % 2 !== 0) {
    result += '\n```'
  }

  // Only fix inline markers outside of code blocks
  if (tripleBackticks % 2 === 0) {
    // Count inline backticks outside code blocks (simplified: count ` not part of ```)
    const withoutCodeBlocks = result.replace(/```[\s\S]*?```/g, '')
    const inlineBackticks = (withoutCodeBlocks.match(/`/g) || []).length
    if (inlineBackticks % 2 !== 0) {
      result += '`'
    }

    // Count ** pairs
    const boldMarkers = (withoutCodeBlocks.match(/\*\*/g) || []).length
    if (boldMarkers % 2 !== 0) {
      result += '**'
    }
  }

  return result
}

/* ── Timestamp formatting ──────────────────────────────── */

function formatTimestamp(ts: number): string {
  if (validTimestamp(ts) === null) return ''
  const now = new Date()
  const date = new Date(ts)
  const isToday = now.toDateString() === date.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = yesterday.toDateString() === date.toDateString()
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  if (isToday) return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`
}

function shouldShowTimestamp(messages: Message[], index: number): boolean {
  if (validTimestamp(messages[index]?.timestamp) === null) return false
  if (index === 0) return true
  if (validTimestamp(messages[index - 1]?.timestamp) === null) return false
  const gap = messages[index].timestamp - messages[index - 1].timestamp
  return gap > 5 * 60 * 1000
}

/* ── Role-switch spacer ─────────────────────────────────── */

// One source of truth for the gap above a row, computed from the previous
// message's role. The streaming container uses the SAME function as the final
// row that replaces it, so the swap is a pure text-node replacement — zero
// movement by construction.
export function turnSpacerClass(prevRole: Message['role'], role: Message['role']): string {
  // The switch AFTER a user message gets extra headroom (24px): the accent
  // bubble's fill weight optically eats a plain 16px gap before the reply.
  if (prevRole === 'user' && role !== 'user') return 'h-[var(--space-6)]'
  if (prevRole !== role) return 'h-[var(--space-4)]'
  return 'h-[var(--space-1)]'
}

/* ── Shared assistant row shell ─────────────────────────── */

// ONE shell, used byte-identically by the streaming container and the final
// MessageRow that replaces it. The structural-parity guarantee (the swap can
// never move the text) holds because both sides render THIS component — no
// hand-copied class strings that can drift apart.

export function TimestampDivider({ label }: { label: string }) {
  return (
    <div className="text-center py-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
      {label}
    </div>
  )
}

export function AssistantRowShell({ transcript, children }: { transcript?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="assistant-msg-row flex min-w-0 justify-start mb-[var(--space-1)]">
      <div className="assistant-msg-bubble flex min-w-0 flex-col">
        {transcript != null && (
          <div className="assistant-transcript py-[var(--space-1)] text-[var(--text-primary)] text-[length:var(--text-body)] leading-[var(--leading-relaxed)]">
            {transcript}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/* ── MessageActions — subtle copy/retry row under a message ─ */

const ACTION_BTN =
  'inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border-none bg-transparent text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-quaternary)]'
const MESSAGE_ACTIONS_ROW = 'msg-actions mt-0.5 -ml-1 flex h-[26px] items-center gap-0.5'

function MessageActions({ id, text, onRetry, retryDisabled }: { id: string; text: string; onRetry?: () => void; retryDisabled?: boolean }) {
  const [copied, setCopied] = useState(false)
  const tts = useMessageTts(id, text)
  const speaking = tts.phase === 'playing'
  const loading = tts.phase === 'loading'

  function handleCopy() {
    if (!text) return
    navigator.clipboard.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) })
      .catch(() => {})
  }

  return (
    <div className={MESSAGE_ACTIONS_ROW}>
      <button onClick={handleCopy} aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy'} className={ACTION_BTN}>
        {copied ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      {/* Read aloud — toggles play↔pause. Custom (Kokoro) TTS with a browser
          Web Speech fallback; only one message speaks at a time. */}
      <button
        onClick={tts.toggle}
        aria-label={speaking ? 'Pause' : loading ? 'Loading audio' : 'Read aloud'}
        aria-pressed={speaking || loading}
        title={speaking ? 'Pause' : 'Read aloud'}
        className={ACTION_BTN}
      >
        {loading ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : speaking ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="6 3 20 12 6 21 6 3" />
          </svg>
        )}
      </button>
      {onRetry && (
        <button onClick={onRetry} disabled={retryDisabled} aria-label="Retry" title="Resend the previous message" className={ACTION_BTN}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4v6h6M23 20v-6h-6" />
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
          </svg>
        </button>
      )}
    </div>
  )
}

/* ── CollapsibleUserText — auto-collapse long user pastes ── */

// Collapsed bubbles clamp to this rendered height. ~240px ≈ 9–10 lines of the
// user bubble's subheadline/relaxed type — long enough that short prompts and
// normal multi-line questions stay fully visible, short enough that a wall of
// pasted text earns a "Show more". SLACK ensures we only collapse when there's
// something worth revealing (≥ ~2 hidden lines), so the control never appears to
// hide a single clipped word.
export const USER_COLLAPSE_PX = 240
export const USER_COLLAPSE_SLACK = 40

/** Pure: should a user bubble of this full rendered height auto-collapse? */
export function shouldCollapse(
  fullHeight: number,
  threshold = USER_COLLAPSE_PX,
  slack = USER_COLLAPSE_SLACK,
): boolean {
  return fullHeight > threshold + slack
}

// Bottom-edge fade for the collapsed state. A mask (alpha, not color) fades the
// text into the bubble's own --accent-fill background, so it is theme-aware for
// free — no hardcoded rgba, works identically in dark and light.
const COLLAPSE_FADE_MASK =
  `linear-gradient(to bottom, #000 calc(100% - 44px), transparent 100%)`

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    setReduced(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return reduced
}

// Wraps the user bubble's formatted content. Measures the rendered height; when
// it exceeds the threshold it clamps + fades the bottom edge and reveals a quiet
// "Show more / Show less" text control. Height animates via max-height + the
// smooth easing token; reduced-motion snaps with no animation.
function CollapsibleUserText({ children }: { children: React.ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [needsCollapse, setNeedsCollapse] = useState(false)
  const [collapsed, setCollapsed] = useState(true)
  const [fullHeight, setFullHeight] = useState(0)
  const reducedMotion = usePrefersReducedMotion()

  // scrollHeight reports the full content height regardless of the max-height
  // clamp, so measuring stays stable across collapse/expand (no feedback loop).
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => {
      const h = el.scrollHeight
      setFullHeight(h)
      setNeedsCollapse(shouldCollapse(h))
    }
    measure()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    return () => ro?.disconnect()
  }, [children])

  const clamped = needsCollapse && collapsed
  // +8px buffer absorbs sub-pixel/last-line rounding so expanded never clips.
  const maxHeight = !needsCollapse
    ? undefined
    : collapsed
      ? `${USER_COLLAPSE_PX}px`
      : `${fullHeight + 8}px`

  return (
    <>
      <div
        ref={contentRef}
        style={{
          maxHeight,
          overflow: needsCollapse ? 'hidden' : undefined,
          transition:
            needsCollapse && !reducedMotion ? 'max-height 320ms var(--ease-smooth)' : undefined,
          maskImage: clamped ? COLLAPSE_FADE_MASK : undefined,
          WebkitMaskImage: clamped ? COLLAPSE_FADE_MASK : undefined,
        }}
      >
        {children}
      </div>
      {needsCollapse && (
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="mt-[var(--space-1)] -ml-1.5 inline-flex items-center gap-1 rounded-[var(--radius-sm)] border-none bg-transparent py-0.5 px-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] cursor-pointer transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          {collapsed ? 'Show more' : 'Show less'}
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-200 ease-[var(--ease-smooth)] opacity-70 ${collapsed ? 'rotate-0' : 'rotate-180'}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </>
  )
}

/* ── MessageRow — memoized per-message renderer ─────────── */

interface MessageRowProps {
  msg: Message
  index: number
  messages: Message[]
  loading?: boolean
  onRetry?: (text: string) => void
  onPeek?: (peek: CommsPeekData) => void
  /** Live-arrival stagger index for comms rows (null = not arriving). */
  arrival?: number | null
  blockArrivals?: ReadonlyMap<string, LiveBlockArrival>
}

const MessageRow = React.memo(function MessageRow({ msg, index: i, messages, loading, onRetry, onPeek, arrival, blockArrivals }: MessageRowProps) {
  const isUser = msg.role === 'user'
  const isNotification = msg.role === 'notification'
  const showTimestamp = shouldShowTimestamp(messages, i)
  const media = messageMedia(msg)
  const blocks = msg.blocks || []
  const hasBlocks = blocks.length > 0
  const teammate = useMemo(() => parseTeammateReply(msg), [msg])
  const relay = useMemo(() => (teammate ? null : parseAgentRelay(msg)), [msg, teammate])

  // Strip media URLs from text for display
  let textContent = msg.content
  if (media.length > 0 && !msg.media) {
    media.forEach(m => {
      textContent = textContent.replace(m.url, '')
      textContent = textContent.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    })
    textContent = textContent.trim()
  }
  // Defensive: never show the engine-only "Attached files:\n- /abs/path" block that
  // gets appended to the prompt for the CLI. Attachments render as chips/thumbnails.
  textContent = stripAttachedFilesBlock(textContent)
  // Hide auto-generated content labels for media-only messages
  if (msg.media && msg.media.length > 0) {
    const isAutoLabel = textContent.startsWith('[') && textContent.endsWith(']')
    if (isAutoLabel) textContent = ''
  }
  const isBlockFallbackText = hasBlocks && blocks.some((block) => {
    const content = textContent.trim()
    return content === blockFallbackContent(block).trim()
      || content === (block.title || '').trim()
      || content === (block.summary || '').trim()
  })
  if (isBlockFallbackText) textContent = ''

  // Memoize the expensive formatting — re-runs only when textContent changes
  const formattedContent = useMemo(() => formatMessage(textContent), [textContent])

  // Memoize timestamp formatting — avoids Date allocations on every parent re-render
  const formattedTimestamp = useMemo(() => formatTimestamp(msg.timestamp), [msg.timestamp])

  // Retry resends the user message that prompted this assistant reply (the gateway
  // has no in-place regenerate, so re-sending the prior prompt is the honest action).
  const prevUserText = useMemo(() => {
    if (isUser || isNotification) return ''
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === 'user' && messages[j].content.trim()) return messages[j].content
    }
    return ''
  }, [messages, i, isUser, isNotification])

  return (
    <div
      key={msg.id || i}
      data-message-id={msg.id || `idx-${i}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 120px" }}
    >
      {/* Timestamp divider */}
      {showTimestamp && <TimestampDivider label={formattedTimestamp} />}

      {/* Spacing between role switches — shared with the streaming container
          (turnSpacerClass) so the stream→final swap cannot move the text. */}
      {!showTimestamp && i > 0 && (
        <div className={turnSpacerClass(messages[i - 1].role, msg.role)} />
      )}

      {/* Notification message — centered system-style banner */}
      {isNotification && !teammate && !relay && (
        <div className="flex justify-center px-[var(--space-4)] mb-[var(--space-1)]">
          <div className="notification-msg-bubble flex items-start gap-[var(--space-2)] py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-md)] bg-[var(--fill-secondary)] text-[var(--text-secondary)] text-[length:var(--text-caption1)] leading-[var(--leading-relaxed)] max-w-[85%]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 opacity-60">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span>{formattedContent}</span>
          </div>
        </div>
      )}

      {teammate && (
        <div className="assistant-msg-row min-w-0">
          <TeammateReply
            data={teammate}
            timestamp={msg.timestamp}
            messageId={msg.id || `idx-${i}`}
            onPeek={onPeek}
            arriving={arrival != null}
            arrivalDelayMs={arrival != null ? arrival * 90 : undefined}
          />
        </div>
      )}

      {relay && (
        <div className="assistant-msg-row min-w-0">
          <AgentRelay
            data={relay}
            timestamp={msg.timestamp}
            messageId={msg.id || `idx-${i}`}
            onPeek={onPeek}
            arriving={arrival != null}
            arrivalDelayMs={arrival != null ? arrival * 90 : undefined}
          />
        </div>
      )}

      {/* User message */}
      {isUser && (
        <div className="flex flex-col items-end px-[var(--space-3)] lg:px-[var(--space-8)]">
          {textContent && (
            <div className="user-msg-bubble py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-lg)_var(--radius-lg)_var(--radius-sm)_var(--radius-lg)] bg-[var(--accent-fill)] text-[var(--text-primary)] text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] font-[var(--weight-medium)] shadow-[var(--shadow-subtle)]">
              <CollapsibleUserText>{formattedContent}</CollapsibleUserText>
            </div>
          )}
          {media.length > 0 && (
            <div className="user-msg-bubble">
              <MessageMedia media={media} isUser={true} />
            </div>
          )}
        </div>
      )}

      {/* Assistant message — same shell as the streaming container. */}
      {!isUser && !isNotification && (
        <AssistantRowShell transcript={textContent ? formattedContent : undefined}>
          {blocks.length > 0 && (
            <div className="mt-1.5 flex min-w-0 max-w-full flex-col items-start gap-1.5">
              {blocks.map((block) => (
                <ChatBlockInline
                  key={block.id}
                  block={block}
                  onPeek={onPeek}
                  arrival={blockArrivals?.get(block.id)}
                />
              ))}
            </div>
          )}

          {/* Media attachments */}
          {media.length > 0 && <MessageMedia media={media} isUser={false} />}

          {/* Subtle action row — copy + retry (no avatars, full-width preserved) */}
          {textContent && (
            <MessageActions
              id={msg.id || `idx-${i}`}
              text={textContent}
              onRetry={onRetry && prevUserText ? () => onRetry(prevUserText) : undefined}
              retryDisabled={loading}
            />
          )}
        </AssistantRowShell>
      )}
    </div>
  )
})

/* ── StreamingBubble — always re-renders on every token ── */

// Structural parity rule: the streaming row shares the final row's prefix,
// shell and action-row footprint. The caret and controls swap below the answer,
// so a bottom-pinned stream→final replacement does not move its first line.
function StreamingBubble({ streamingText, prevMessage, startedAt }: {
  streamingText: string
  prevMessage?: Message
  startedAt: number
}) {
  const formattedContent = useMemo(
    () => formatMessage(closePartialMarkdown(streamingText)),
    [streamingText]
  )
  const showTimestamp = !prevMessage || startedAt - prevMessage.timestamp > 5 * 60 * 1000
  return (
    <div data-streaming>
      {showTimestamp && <TimestampDivider label={formatTimestamp(startedAt)} />}
      {!showTimestamp && prevMessage && (
        <div className={turnSpacerClass(prevMessage.role, 'assistant')} />
      )}
      <AssistantRowShell
        transcript={(
          <>
            {formattedContent}
            <span className="stream-caret" aria-hidden="true" />
          </>
        )}
      >
        <div data-message-actions-reserve aria-hidden="true" className={MESSAGE_ACTIONS_ROW} />
      </AssistantRowShell>
    </div>
  )
}

/* ── Component ──────────────────────────────────────────── */

interface ChatMessagesProps {
  messages: Message[]
  loading: boolean
  /** The latest turn has started but has not produced a terminal assistant response. */
  turnPending?: boolean
  /** The assistant row appended by the live terminal response event. */
  liveFinalResponseId?: string | null
  streamingText?: string
  /** Resend a prior user message (assistant action-row "retry"). */
  onRetry?: (text: string) => void
  hasOlderMessages?: boolean
  loadingOlderMessages?: boolean
  olderMessagesError?: Error | null
  onLoadOlderMessages?: () => Promise<void> | void
  /** Open the read-only report panel for a comms ledger line. */
  onPeek?: (peek: CommsPeekData) => void
  blockArrivals?: ReadonlyMap<string, LiveBlockArrival>
  liveTerminalDelegationIds?: ReadonlySet<string>
  blockAnnouncement?: string
  /** Final in-thread object. It remains inside the transcript scroll owner. */
  footer?: React.ReactNode
}

function latestTurnId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].id || `t${i}`
  }
  return null
}

const JUMP_EXIT_MS = 140
const OLDER_LOAD_THRESHOLD_PX = 900

interface ScrollAnchor {
  id: string | null
  offset: number
  scrollHeight: number
  scrollTop: number
  token: number
}

function JumpToLatestButton({
  show,
  unreadCount,
  onClick,
}: {
  show: boolean
  unreadCount: number
  onClick: () => void
}) {
  const [rendered, setRendered] = useState(show)
  const [exiting, setExiting] = useState(false)
  const reducedMotion = usePrefersReducedMotion()
  const hasUnread = unreadCount > 0
  const visibleUnread = unreadCount > 99 ? '99+' : String(unreadCount)
  const label = hasUnread
    ? `Jump to latest, ${unreadCount} new message${unreadCount === 1 ? '' : 's'}`
    : 'Jump to latest'

  useEffect(() => {
    if (show) {
      setRendered(true)
      setExiting(false)
      return
    }
    if (!rendered) return

    setExiting(true)
    const timer = window.setTimeout(() => {
      setRendered(false)
      setExiting(false)
    }, reducedMotion ? 1 : JUMP_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [show, reducedMotion, rendered])

  if (!rendered) return null

  const motionClass = reducedMotion
    ? 'data-[state=exiting]:opacity-0 data-[state=visible]:opacity-100'
    : 'data-[state=exiting]:animate-[jinn-jump-out_140ms_var(--ease-snappy)_both] data-[state=visible]:animate-[jinn-jump-in_160ms_var(--ease-smooth)_both]'

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-hidden={exiting ? true : undefined}
      tabIndex={exiting ? -1 : undefined}
      data-state={exiting ? 'exiting' : 'visible'}
      className={`absolute bottom-4 left-1/2 z-10 inline-flex h-10 w-10 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full bg-[var(--material-thick)] px-0 text-[var(--text-secondary)] shadow-[var(--shadow-overlay)] backdrop-blur-md transition-[background-color,transform,opacity] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.96] data-[state=exiting]:pointer-events-none [@media(pointer:fine)]:h-9 [@media(pointer:fine)]:w-9 ${motionClass}`}
    >
      <ChevronDown size={18} strokeWidth={2.25} aria-hidden="true" className="-mb-px shrink-0" />
      {hasUnread && (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-[var(--weight-semibold)] leading-none text-[var(--accent-contrast)] shadow-[var(--shadow-subtle)] tabular-nums"
        >
          {visibleUnread}
        </span>
      )}
    </button>
  )
}

function captureVisibleAnchor(node: HTMLDivElement, token: number): ScrollAnchor {
  const containerRect = node.getBoundingClientRect()
  const rows = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]'))
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom >= containerRect.top && rect.top <= containerRect.bottom) {
      return {
        id: row.getAttribute('data-message-id'),
        offset: rect.top - containerRect.top,
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
        token,
      }
    }
  }
  return {
    id: null,
    offset: 0,
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop,
    token,
  }
}

function restoreVisibleAnchor(node: HTMLDivElement, anchor: ScrollAnchor) {
  if (anchor.id) {
    const target = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((row) => row.getAttribute('data-message-id') === anchor.id)
    if (target) {
      const containerRect = node.getBoundingClientRect()
      const rect = target.getBoundingClientRect()
      node.scrollTop += rect.top - containerRect.top - anchor.offset
      return
    }
  }
  node.scrollTop = anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight)
}

export function ChatMessages({
  messages,
  loading,
  turnPending = loading,
  liveFinalResponseId = null,
  streamingText,
  onRetry,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  olderMessagesError = null,
  onLoadOlderMessages,
  onPeek,
  blockArrivals = new Map(),
  liveTerminalDelegationIds = new Set(),
  blockAnnouncement = '',
  footer,
}: ChatMessagesProps) {
  // Stick-to-bottom: one hook owns follow-intent, growth-follow, resize/keyboard,
  // tab-return, mount-snap, and the jump affordance. See use-stick-to-bottom.ts.
  const { containerRef, showJump, unreadCount, scrollToBottom } = useStickToBottom({
    streamingText,
    messageCount: messages.length,
    latestMessageKey: messages.at(-1)?.id ?? null,
  })
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const pendingAnchorRef = useRef<ScrollAnchor | null>(null)
  const anchorTokenRef = useRef(0)
  const olderRequestInFlightRef = useRef(false)
  const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node
    setScrollEl(node)
    containerRef(node)
  }, [containerRef])

  useEffect(() => {
    olderRequestInFlightRef.current = loadingOlderMessages
  }, [loadingOlderMessages])

  const requestOlderMessages = useCallback(() => {
    const node = scrollContainerRef.current
    if (!node || !hasOlderMessages || !onLoadOlderMessages || olderRequestInFlightRef.current) return
    const token = ++anchorTokenRef.current
    pendingAnchorRef.current = captureVisibleAnchor(node, token)
    olderRequestInFlightRef.current = true
    Promise.resolve(onLoadOlderMessages())
      .catch(() => { /* hook owns the visible error state */ })
      .finally(() => {
        olderRequestInFlightRef.current = false
        requestAnimationFrame(() => {
          if (pendingAnchorRef.current?.token !== token) return
          const currentNode = scrollContainerRef.current
          if (currentNode) restoreVisibleAnchor(currentNode, pendingAnchorRef.current)
          if (pendingAnchorRef.current?.token === token) pendingAnchorRef.current = null
        })
      })
  }, [hasOlderMessages, onLoadOlderMessages])

  useEffect(() => {
    if (!scrollEl) return
    const onScroll = () => {
      if (scrollEl.scrollTop <= OLDER_LOAD_THRESHOLD_PX) requestOlderMessages()
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', onScroll)
  }, [requestOlderMessages, scrollEl])

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current
    const node = scrollContainerRef.current
    if (!anchor || !node) return
    restoreVisibleAnchor(node, anchor)
    pendingAnchorRef.current = null
  }, [messages])

  // The hook owns terminal-response lifecycle independently of `loading`, which
  // can clear for waiting/idle/stopped states. Until a real final response lands,
  // the latest turn remains ordinary stream content with no fold DOM.
  const previousTurnPendingRef = useRef(turnPending)
  const turnJustCompleted = previousTurnPendingRef.current && !turnPending
  useEffect(() => {
    previousTurnPendingRef.current = turnPending
  }, [turnPending])
  const latestMessage = messages.at(-1)
  const effectiveLiveFinalResponseId = liveFinalResponseId ?? (
    turnJustCompleted && latestMessage?.role === 'assistant' && !latestMessage.partial
      ? latestMessage.id ?? null
      : null
  )
  const currentTurnId = latestTurnId(messages)
  const liveFinalPresent = effectiveLiveFinalResponseId === null
    || messages.some((message) => message.id === effectiveLiveFinalResponseId)
  const incompleteTurnIds = (turnPending || !liveFinalPresent) && currentTurnId
    ? new Set([currentTurnId])
    : new Set<string>()

  // Memoize grouped messages to avoid re-running on streaming-only re-renders
  const groupedMessages = useMemo(() => groupMessages(messages), [messages])
  const renderGroups = partitionForFold(
    groupedMessages,
    messages,
    incompleteTurnIds,
    effectiveLiveFinalResponseId,
    liveTerminalDelegationIds,
  )

  // Live-arrival tracking for the comms choreography: ids present at mount
  // never animate; comms rows appended while mounted play the arrival once,
  // staggered +90ms per row within a delivery batch. The refs are mutated in
  // this memo on purpose — assignments must be visible to the SAME render.
  const seenIdsRef = useRef<Set<string> | null>(null)
  const arrivalsRef = useRef<Map<string, number>>(new Map())
  useMemo(() => {
    const seen = seenIdsRef.current
    if (!seen) return
    let batchIndex = 0
    for (const message of messages) {
      if (!message.id || seen.has(message.id)) continue
      seen.add(message.id)
      if (message.role === 'notification' && (parseTeammateReply(message) || parseAgentRelay(message))) {
        arrivalsRef.current.set(message.id, batchIndex++)
      }
    }
  }, [messages])
  useEffect(() => {
    if (!seenIdsRef.current) {
      seenIdsRef.current = new Set(messages.map((message) => message.id).filter(Boolean) as string[])
    }
  }, [messages])
  const arrivalFor = (id: string | undefined): number | null =>
    id != null ? arrivalsRef.current.get(id) ?? null : null

  // Captured when the first token lands so the streaming container can render
  // the same timestamp-divider decision as the final row that will replace it.
  const streamStartRef = useRef<number | null>(null)
  if (streamingText && streamStartRef.current == null) streamStartRef.current = Date.now()
  if (!streamingText && streamStartRef.current != null) streamStartRef.current = null
  const activeToolGroupStart = useMemo(() => {
    if (!loading) return -1
    for (let i = groupedMessages.length - 1; i >= 0; i--) {
      const item = groupedMessages[i]
      if (item.kind === 'tool-group' && item.msgs.some((msg) => !isToolDone(msg))) {
        return item.startIndex
      }
    }
    return -1
  }, [groupedMessages, loading])

  // Stop any in-progress read-aloud when the chat view unmounts (navigation away).
  useEffect(() => () => stopMessageTts(), [])

  if (messages.length === 0 && !loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
            Start a conversation
          </div>
          <div className="text-[length:var(--text-footnote)] text-[var(--text-quaternary)] mt-[var(--space-2)]">
            Send a message or use /new to begin
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0 bg-[var(--bg)]">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {blockAnnouncement}
      </span>
      <div ref={setScrollContainerRef} style={{ overflowAnchor: 'auto' }} className="chat-messages-scroll h-full overflow-y-auto overflow-x-hidden bg-[var(--bg)] min-h-0">
        <div className={`mx-auto w-full max-w-[var(--chat-measure)] pt-[72px] lg:pt-[88px] ${footer ? 'flex min-h-full flex-col justify-end pb-0' : 'pb-[var(--space-6)]'}`}>
          {loadingOlderMessages && (
            <div role="status" aria-label="Loading older messages" className="flex h-8 items-center justify-center">
              <span className="size-3 rounded-full bg-[var(--fill-tertiary)] animate-[jinn-pulse_1.4s_infinite]" />
            </div>
          )}
          {olderMessagesError && hasOlderMessages && (
            <div className="flex h-8 items-center justify-center text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
              Older messages could not load
            </div>
          )}
          {renderGroups.map((group) => {
            const renderItem = (item: MessageItem) => {
              if (item.kind === 'tool-group' || item.kind === 'dispatch-call' || item.kind === 'callback-burst' || item.kind === 'todo-burst') {
                const firstMsg = itemFirstMsg(item)
                const startIndex = item.kind === 'dispatch-call' ? item.index : item.startIndex
                const showTimestamp = shouldShowTimestamp(messages, startIndex)
                const prevMsg = startIndex > 0 ? messages[startIndex - 1] : null
                return (
                  <div key={`tg-${firstMsg.id || startIndex}`} data-message-id={firstMsg.id || `tg-${startIndex}`}>
                    {showTimestamp && <TimestampDivider label={formatTimestamp(firstMsg.timestamp)} />}
                    {!showTimestamp && prevMsg && (
                      <div className={turnSpacerClass(prevMsg.role, 'assistant')} />
                    )}
                    {item.kind === 'tool-group' && (
                      <ToolGroup msgs={item.msgs} isActive={item.startIndex === activeToolGroupStart} />
                    )}
                    {item.kind === 'dispatch-call' && (
                      <div className="assistant-msg-row mb-[var(--space-1)] min-w-0">
                        <DispatchRow />
                      </div>
                    )}
                    {item.kind === 'callback-burst' && (
                      <div className="assistant-msg-row mb-[var(--space-1)] min-w-0">
                        <CallbackBurst
                          entries={item.entries}
                          onPeek={onPeek}
                          arrivals={arrivalsRef.current}
                        />
                      </div>
                    )}
                    {item.kind === 'todo-burst' && (
                      <div className="assistant-msg-row mb-[var(--space-1)] min-w-0">
                        <TodoActivityBurst
                          blocks={item.msgs.flatMap((message) => message.blocks ?? [])}
                        />
                      </div>
                    )}
                  </div>
                )
              }

              const { msg, index: i } = item
              return (
                <MessageRow
                  key={msg.id || i}
                  msg={msg}
                  index={i}
                  messages={messages}
                  loading={loading}
                  onRetry={onRetry}
                  onPeek={onPeek}
                  arrival={arrivalFor(msg.id)}
                  blockArrivals={blockArrivals}
                />
              )
            }

            if (group.kind === 'plain') return renderItem(group.item)
            return (
              <FoldRegion
                key={`fold-${group.id}`}
                answered={group.answered}
                liveCompletion={group.liveCompletion}
                collapseRequested={group.collapseRequested}
                summary={group.summary}
                animated={group.animated}
              >
                {group.items.map(renderItem)}
              </FoldRegion>
            )
          })}

          {/* Streaming message — shows text as it arrives, always re-renders */}
          {streamingText && (
            <StreamingBubble
              streamingText={streamingText}
              prevMessage={messages.at(-1)}
              startedAt={streamStartRef.current ?? Date.now()}
            />
          )}

          {/* Running indicator — pre-first-token only; once streamingText arrives the
              caret carries the "live" signal, so suppress this to avoid a double cue. */}
          {loading && messages.length > 0 && !streamingText && (
            // Share the assistant text gutter (space-3 mobile / space-8 @lg) so the
            // indicator lines up flush with the messages and tool cards.
            <div className="assistant-msg-row mt-[var(--space-1)]">
              {/* No inner inset — the dot/label sit flush at the assistant-msg-row
                  gutter, sharing the same leading edge as assistant prose. */}
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-[jinn-pulse_1.4s_infinite] shrink-0" />
                <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)]">
                  Thinking
                </span>
              </div>
            </div>
          )}

          {footer && (
            <div className="mt-[var(--space-5)] px-[var(--space-3)] lg:px-[var(--space-8)]">
              {footer}
            </div>
          )}

        </div>
      </div>

      {/* Jump-to-latest — outside the scrollable transcript so it stays pinned
          above the composer instead of moving with the message content. */}
      <JumpToLatestButton
        show={showJump}
        unreadCount={unreadCount}
        onClick={() => scrollToBottom('smooth')}
      />

      {/* Keyframe animations + responsive bubble widths */}
      <style>{`
        @keyframes jinn-pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes jinn-jump-in {
          from { opacity: 0; transform: translateY(8px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes jinn-jump-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(6px) scale(0.98); }
        }
        .assistant-msg-bubble { max-width: 100%; overflow-wrap: break-word; word-break: break-word; }
        .user-msg-bubble { max-width: 90%; overflow-wrap: break-word; word-break: break-word; }
        .notification-msg-bubble { overflow-wrap: break-word; word-break: break-word; white-space: pre-wrap; }
        .assistant-msg-row { padding: 0 var(--space-3) !important; }
        @media (min-width: 1024px) {
          .assistant-msg-bubble { max-width: 100%; }
          .user-msg-bubble { max-width: 82%; }
          .assistant-msg-row { padding: 0 var(--space-8) !important; }
        }
        /* Streaming caret — CSS-only, theme-aware via currentColor. */
        .stream-caret {
          display: inline-block;
          width: 0.5em;
          height: 1em;
          margin-left: 1px;
          vertical-align: text-bottom;
          background: currentColor;
          border-radius: 1px;
          opacity: 0.55;
          animation: jinn-caret 1.05s steps(1) infinite;
        }
        @keyframes jinn-caret { 0%, 50% { opacity: 0.55; } 50.01%, 100% { opacity: 0; } }
        /* Message actions — always visible by default (touch). On hover-capable
           pointers, hide at rest and reveal on row hover/focus. No !important. */
        .msg-actions { opacity: 1; transition: opacity 150ms ease; }
        @media (hover: hover) {
          .assistant-msg-row .msg-actions { opacity: 0; }
          .assistant-msg-row:hover .msg-actions,
          .assistant-msg-row:focus-within .msg-actions { opacity: 1; }
        }
        @media (hover: none) {
          .msg-actions button { min-height: 36px; min-width: 36px; }
        }
      `}</style>
    </div>
  )
}
