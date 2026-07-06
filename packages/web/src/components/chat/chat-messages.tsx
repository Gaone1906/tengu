import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@/lib/conversations'
import { parseMedia, stripAttachedFilesBlock } from '@/lib/conversations'
import { MessageMedia } from './message-media'
import { useOpenFile } from '@/components/chat/file-open-context'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'
import { useMessageTts, stopMessageTts } from './use-message-tts'
import { ChatBlockInline, statusMark } from './chat-blocks'
import { blockFallbackContent } from '@/lib/blocks'
import { ChevronDown, Wrench } from 'lucide-react'

/* ── Tool grouping ──────────────────────────────────────── */

type MessageItem =
  | { kind: 'message'; msg: Message; index: number }
  | { kind: 'tool-group'; msgs: Message[]; startIndex: number }

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

function groupMessages(messages: Message[]): MessageItem[] {
  const items: MessageItem[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i].role === 'assistant' && messages[i].toolCall) {
      const toolMsgs: Message[] = []
      const start = i
      while (i < messages.length && messages[i].role === 'assistant' && messages[i].toolCall) {
        toolMsgs.push(messages[i])
        i++
      }
      items.push({ kind: 'tool-group', msgs: toolMsgs, startIndex: start })
    } else {
      items.push({ kind: 'message', msg: messages[i], index: i })
      i++
    }
  }
  return items
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
            return (
              <div
                key={key}
                className="inline-flex min-h-9 max-w-full items-center gap-1.5 px-2.5 py-1 text-left"
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {statusMark(status)}
                </span>
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

/* ── Markdown rendering ─────────────────────────────────── */

// Single source of truth for the file-path pattern: optional ~/ or / prefix,
// ≥1 slash-separated segment, ending in a short extension. Requiring a slash +
// an extension filters out branch names (feat/clickable-file-paths), mime types
// (text/markdown), version numbers (0.16.1) and bare words (config.yaml — no slash).
// Both the anchored test (isFilePath) and the inline-formatter alternative below
// derive from this core string so the two can never drift apart.
const FILE_PATH_CORE = String.raw`(?:~\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8}`
const FILE_PATH_RE = new RegExp(`^${FILE_PATH_CORE}$`)
export function isFilePath(s: string): boolean {
  return FILE_PATH_RE.test(s.trim())
}

// Inline-formatter pattern, assembled from the shared FILE_PATH_CORE so the
// bare-path alternative (capture group 9) stays identical to FILE_PATH_RE.
// Groups: 1,2 md-link · 3 url · 4,5 bold · 6,7 inline-code · 8 italic · 9 path.
const INLINE_RE_SOURCE =
  String.raw`\[([^\]]+)\]\(([^)]+)\)` +                 // [text](url)
  String.raw`|(https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"])` + // bare URL
  String.raw`|(\*\*(.+?)\*\*)` +                        // **bold**
  '|(`([^`]+)`)' +                                      // `inline code`
  String.raw`|\*([^*]+)\*` +                            // *italic*
  `|(${FILE_PATH_CORE})`                                // bare file path

// Render a file path as a clean clickable link. Opens the file in an in-app tab
// when a FileOpenContext provider is present (chat page); otherwise / on
// modified clicks it falls back to the real `/file?path=` browser route.
// Monospace + blue underline (no code-box background — that looked like an empty highlight).
function FileLink({ path }: { path: string }) {
  const openFile = useOpenFile()
  const trimmed = path.trim()
  const href = `/file?path=${encodeURIComponent(trimmed)}`
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${trimmed} in viewer`}
      onClick={(e) => {
        // Let modified clicks (cmd/ctrl/shift/middle) fall through to a real browser tab.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        if (openFile) { e.preventDefault(); openFile(trimmed) }
      }}
      className="text-[var(--system-blue)] underline decoration-[var(--system-blue)]/40 hover:decoration-[var(--system-blue)] underline-offset-2 font-[family-name:var(--font-code)] text-[0.88em]"
    >
      {path}
    </a>
  )
}

function renderPathLink(p: string, key: React.Key): React.ReactNode {
  return <FileLink key={key} path={p} />
}

function safeMarkdownHref(href: string): string | null {
  const trimmed = href.trim()
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null
}

function inlineFormat(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  // Fresh regex per call (own lastIndex — inlineFormat recurses for table cells).
  const regex = new RegExp(INLINE_RE_SOURCE, 'g')
  let last = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1] && match[2]) {
      // Markdown link: [text](url)
      const href = safeMarkdownHref(match[2])
      parts.push(href
        ? (
          <a
            key={match.index}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--system-blue)] underline underline-offset-2"
          >
            {match[1]}
          </a>
        )
        : match[1])
    } else if (match[3]) {
      // Bare URL
      parts.push(
        <a
          key={match.index}
          href={match[3]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--system-blue)] underline underline-offset-2"
        >
          {match[3]}
        </a>
      )
    } else if (match[4]) {
      parts.push(<strong key={match.index} className="font-[var(--weight-bold)]">{match[5]}</strong>)
    } else if (match[6]) {
      // Inline `code` — but if it's actually a file path, make it a viewer link.
      // Agents almost always wrap paths in backticks, so this is the common case.
      if (isFilePath(match[7])) {
        parts.push(renderPathLink(match[7], match.index))
      } else {
        parts.push(
          <code key={match.index} className="bg-[var(--fill-secondary)] rounded-[5px] py-px px-[5px] text-[0.88em] font-[family-name:var(--font-code)] text-[var(--text-primary)]">{match[7]}</code>
        )
      }
    } else if (match[8]) {
      parts.push(<em key={match.index} className="italic opacity-[0.85]">{match[8]}</em>)
    } else if (match[9]) {
      // Bare (un-backticked) file path → viewer link
      parts.push(renderPathLink(match[9], match.index))
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length === 1 ? parts[0] : <>{parts}</>
}

// Parse the language label off a ```fence line. Returns lowercased first token
// (e.g. ```tsx {3-5} → "tsx"), or '' for a bare ``` fence.
export function parseFenceLang(line: string): string {
  const after = line.replace(/^```/, '').trim()
  if (!after) return ''
  return after.split(/\s+/)[0].toLowerCase()
}

function CodeBlock({ code, lang, keyProp }: { code: string; lang?: string; keyProp: number }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    // Soft contained card — no hairline (fill + shadow-subtle). The header strip
    // lifts the copy button off the first line of code (fixes mobile overlap).
    <div key={keyProp} className="code-block-wrap my-[var(--space-2)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--fill-tertiary)] shadow-[var(--shadow-subtle)]">
      <div className="flex items-center justify-between gap-[var(--space-2)] py-[3px] pl-[var(--space-3)] pr-[var(--space-1)] bg-[var(--fill-secondary)]">
        <span className="text-[length:var(--text-caption2)] tracking-wide text-[var(--text-tertiary)] font-[family-name:var(--font-code)]">
          {lang || 'text'}
        </span>
        <button
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy'}
          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border-none bg-transparent text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer"
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
      <pre className="code-block overflow-x-auto py-[var(--space-3)] px-[var(--space-4)] text-[length:var(--text-footnote)] leading-normal font-[family-name:var(--font-code)] text-[var(--text-primary)]"><code>{code}</code></pre>
    </div>
  )
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim())
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

function TableBlock({ headerLine, rows, keyProp }: { headerLine: string; rows: string[]; keyProp: number }) {
  const headers = parseTableRow(headerLine)
  const bodyRows = rows.map(parseTableRow)

  return (
    <div key={keyProp} className="my-[var(--space-3)] rounded-[var(--radius-md)] overflow-hidden shadow-[var(--shadow-subtle)]">
      <div className="overflow-x-auto [WebkitOverflowScrolling:touch]">
        <table className="border-collapse text-[length:var(--text-footnote)] leading-[1.6] w-full min-w-max">
          <thead>
            <tr className="bg-[var(--fill-tertiary)]">
              {headers.map((h, hi) => (
                <th key={hi} className="text-left py-2.5 px-4 font-semibold text-[var(--text-primary)] max-w-[280px] break-words">{inlineFormat(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 1 ? 'bg-[var(--fill-quaternary)]' : 'bg-transparent'}>
                {row.map((cell, ci) => (
                  <td key={ci} className="py-2.5 px-4 text-[var(--text-primary)] max-w-[280px] break-words">{inlineFormat(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatMessage(content: string): React.ReactNode {
  if (!content) return null
  const lines = content.split('\n')
  const result: React.ReactNode[] = []
  let inCodeBlock = false
  let codeLines: string[] = []
  let codeLang = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLines = []
        codeLang = parseFenceLang(line)
      } else {
        inCodeBlock = false
        result.push(<CodeBlock key={i} keyProp={i} code={codeLines.join('\n')} lang={codeLang} />)
        codeLines = []
        codeLang = ''
      }
      continue
    }
    if (inCodeBlock) { codeLines.push(line); continue }

    // Table detection: header row | separator row | body rows
    if (line.trim().startsWith('|') && line.trim().endsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerLine = line
      i++ // skip separator
      const tableRows: string[] = []
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|') && lines[i + 1].trim().endsWith('|') && !isTableSeparator(lines[i + 1])) {
        i++
        tableRows.push(lines[i])
      }
      result.push(<TableBlock key={`table-${i}`} keyProp={i} headerLine={headerLine} rows={tableRows} />)
      continue
    }

    if (line.trim() === '') { result.push(<div key={`space-${i}`} className="h-1.5" />); continue }
    if (line.match(/^[-*] /)) {
      result.push(
        <div key={i} className="flex gap-[var(--space-2)] mb-1">
          <span className="text-[var(--text-tertiary)] shrink-0 mt-px">&bull;</span>
          <span>{inlineFormat(line.slice(2))}</span>
        </div>
      )
      continue
    }
    if (line.match(/^\d+\. /)) {
      const num = line.match(/^(\d+)\. /)?.[1]
      result.push(
        <div key={i} className="flex gap-[var(--space-2)] mb-1">
          <span className="text-[var(--text-secondary)] shrink-0 font-[var(--weight-semibold)] min-w-4">{num}.</span>
          <span>{inlineFormat(line.replace(/^\d+\. /, ''))}</span>
        </div>
      )
      continue
    }
    if (line.startsWith('### ')) {
      result.push(
        <div key={i} className="font-[var(--weight-semibold)] text-[length:var(--text-body)] mt-[var(--space-4)] mb-[var(--space-2)]">
          {inlineFormat(line.slice(4))}
        </div>
      )
      continue
    }
    if (line.startsWith('## ')) {
      result.push(
        <div key={i} className="font-[var(--weight-bold)] text-[18px] mt-[var(--space-4)] mb-[var(--space-2)]">
          {inlineFormat(line.slice(3))}
        </div>
      )
      continue
    }
    if (line.startsWith('# ')) {
      result.push(
        <div key={i} className="font-[var(--weight-bold)] text-[length:var(--text-title3)] mt-[var(--space-4)] mb-[var(--space-2)]">
          {inlineFormat(line.slice(2))}
        </div>
      )
      continue
    }
    result.push(<div key={i} className="mb-[var(--space-2)] last:mb-0">{inlineFormat(line)}</div>)
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    result.push(<CodeBlock key="trailing-code" keyProp={999} code={codeLines.join('\n')} lang={codeLang} />)
  }

  return <>{result}</>
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
  if (index === 0) return true
  const gap = messages[index].timestamp - messages[index - 1].timestamp
  return gap > 5 * 60 * 1000
}

/* ── MessageActions — subtle copy/retry row under a message ─ */

const ACTION_BTN =
  'inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border-none bg-transparent text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-quaternary)]'

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
    <div className="msg-actions mt-0.5 -ml-1 flex items-center gap-0.5">
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
}

const MessageRow = React.memo(function MessageRow({ msg, index: i, messages, loading, onRetry }: MessageRowProps) {
  const isUser = msg.role === 'user'
  const isNotification = msg.role === 'notification'
  const showTimestamp = shouldShowTimestamp(messages, i)
  const media = msg.media || parseMedia(msg.content)
  const blocks = msg.blocks || []
  const hasBlocks = blocks.length > 0

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
    <div key={msg.id || i}>
      {/* Timestamp divider */}
      {showTimestamp && (
        <div className="text-center py-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          {formattedTimestamp}
        </div>
      )}

      {/* Spacing between role switches */}
      {!showTimestamp && i > 0 && (
        <div className={messages[i - 1].role !== msg.role ? 'h-[var(--space-4)]' : 'h-[var(--space-1)]'} />
      )}

      {/* Notification message — centered system-style banner */}
      {isNotification && (
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

      {/* Assistant message */}
      {!isUser && !isNotification && (
        <div className="assistant-msg-row flex min-w-0 justify-start mb-[var(--space-1)]">
          <div className="assistant-msg-bubble flex min-w-0 flex-col">
            {/* Text bubble */}
            {textContent && (
              <div className="assistant-transcript py-[var(--space-1)] text-[var(--text-primary)] text-[length:var(--text-body)] leading-[var(--leading-relaxed)]">
                {formattedContent}
              </div>
            )}

            {blocks.length > 0 && (
              <div className="mt-1.5 flex min-w-0 max-w-full flex-col items-start gap-1.5">
                {blocks.map((block) => (
                  <ChatBlockInline
                    key={block.id}
                    block={block}
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
          </div>
        </div>
      )}
    </div>
  )
})

/* ── StreamingBubble — always re-renders on every token ── */

function StreamingBubble({ streamingText }: { streamingText: string }) {
  const formattedContent = useMemo(
    () => formatMessage(closePartialMarkdown(streamingText)),
    [streamingText]
  )
  return (
    <div className="assistant-msg-row flex justify-start mb-[var(--space-1)]">
      <div className="assistant-msg-bubble flex flex-col">
        <div className="assistant-transcript py-[var(--space-1)] text-[var(--text-primary)] text-[length:var(--text-body)] leading-[var(--leading-relaxed)]">
          {formattedContent}
          <span className="stream-caret" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}

/* ── Component ──────────────────────────────────────────── */

interface ChatMessagesProps {
  messages: Message[]
  loading: boolean
  streamingText?: string
  /** Resend a prior user message (assistant action-row "retry"). */
  onRetry?: (text: string) => void
}

const JUMP_EXIT_MS = 140

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

export function ChatMessages({ messages, loading, streamingText, onRetry }: ChatMessagesProps) {
  // Stick-to-bottom: one hook owns follow-intent, growth-follow, resize/keyboard,
  // tab-return, mount-snap, and the jump affordance. See use-stick-to-bottom.ts.
  const { containerRef, showJump, unreadCount, scrollToBottom } = useStickToBottom({
    streamingText,
    messageCount: messages.length,
  })

  // Memoize grouped messages to avoid re-running on streaming-only re-renders
  const groupedMessages = useMemo(() => groupMessages(messages), [messages])
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
      <div ref={containerRef} style={{ overflowAnchor: 'auto' }} className="chat-messages-scroll h-full overflow-y-auto overflow-x-hidden bg-[var(--bg)] min-h-0">
        <div className="mx-auto w-full max-w-[var(--chat-measure)] pt-[72px] pb-[var(--space-6)] lg:pt-[88px]">
          {groupedMessages.map((item) => {
            if (item.kind === 'tool-group') {
              const firstMsg = item.msgs[0]
              const showTimestamp = shouldShowTimestamp(messages, item.startIndex)
              const prevMsg = item.startIndex > 0 ? messages[item.startIndex - 1] : null
              const isActive = item.startIndex === activeToolGroupStart
              return (
                <div key={`tg-${item.startIndex}`}>
                  {showTimestamp && (
                    <div className="text-center py-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                      {formatTimestamp(firstMsg.timestamp)}
                    </div>
                  )}
                  {!showTimestamp && prevMsg && (
                    <div className={prevMsg.role !== 'assistant' ? 'h-[var(--space-4)]' : 'h-[var(--space-1)]'} />
                  )}
                  <ToolGroup msgs={item.msgs} isActive={isActive} />
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
              />
            )
          })}

          {/* Streaming message — shows text as it arrives, always re-renders */}
          {streamingText && <StreamingBubble streamingText={streamingText} />}

          {/* Running indicator — pre-first-token only; once streamingText arrives the
              caret carries the "live" signal, so suppress this to avoid a double cue. */}
          {loading && messages.length > 0 && !streamingText && (
            // Share the assistant text gutter (space-3 mobile / space-8 @lg) so the
            // indicator lines up flush with the messages and tool cards.
            <div className="assistant-msg-row flex items-center gap-1.5 mt-[var(--space-1)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-[jinn-pulse_1.4s_infinite] shrink-0" />
              <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)]">
                Thinking
              </span>
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
