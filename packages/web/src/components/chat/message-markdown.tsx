import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { buildFileReadRequest } from '@/lib/file-read-request'
import { isTodoId, TODO_ID_MENTION_SOURCE, todoPath } from '@/lib/todo-id'
import { useOpenFile } from '@/components/chat/file-open-context'
import { useKnownTodoPrefixes } from '@/components/chat/todo-prefix-context'
import { CodeBlockChrome } from '@/components/code-block-chrome'
import { ChevronDown } from 'lucide-react'

// Bare paths stay deliberately narrow: optional ~/ or / prefix, ≥1
// slash-separated segment, and a short extension. Backticked paths may use the
// viewer's supported roots and broader filename characters; the backticks give
// that form an unambiguous boundary without making ordinary prose linkable.
const FILE_PATH_CORE = String.raw`(?:~\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8}`
const FILE_PATH_RE = new RegExp(`^${FILE_PATH_CORE}$`)
const SUPPORTED_VIEWER_ROOT_RE = /^(?:knowledge|docs|files|uploads)\//

function buildChatFileLink(path: string): { trimmed: string; href: string } | null {
  const trimmed = path.trim()
  if (SUPPORTED_VIEWER_ROOT_RE.test(trimmed)) {
    if (!buildFileReadRequest(trimmed).ok) return null
  } else if (!FILE_PATH_RE.test(trimmed)) {
    return null
  }
  return { trimmed, href: `/file?path=${encodeURIComponent(trimmed)}` }
}

export function isFilePath(s: string): boolean {
  return buildChatFileLink(s) !== null
}

// Inline-formatter pattern, assembled from the shared FILE_PATH_CORE so the
// bare-path alternative (capture group 9) stays identical to FILE_PATH_RE.
// Groups: 1,2 md-link · 3 url · 4,5 bold · 6,7 inline-code · 8 italic · 9 path · 10 Todo.
const INLINE_RE_SOURCE =
  String.raw`\[([^\]]+)\]\(([^)]+)\)` +                 // [text](url)
  String.raw`|(https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"])` + // bare URL
  String.raw`|(\*\*(.+?)\*\*)` +                        // **bold**
  '|(`([^`\r\n]+)`)' +                                  // `inline code`
  String.raw`|\*([^*]+)\*` +                            // *italic*
  `|(${FILE_PATH_CORE})` +                              // bare file path
  `|(${TODO_ID_MENTION_SOURCE})`                        // live Todo candidate

// Render a file path as a clean clickable link. Opens the file in an in-app tab
// when a FileOpenContext provider is present (chat page); otherwise / on
// modified clicks it falls back to the real `/file?path=` browser route.
// Monospace + blue underline (no code-box background — that looked like an empty highlight).
function FileLink({ path }: { path: string }) {
  const openFile = useOpenFile()
  const link = buildChatFileLink(path)
  if (!link) return path
  const { trimmed, href } = link
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

function InlineCode({ children }: { children: string }) {
  return (
    <code className="bg-[var(--fill-secondary)] rounded-[5px] py-px px-[5px] text-[0.88em] font-[family-name:var(--font-code)] text-[var(--text-primary)]">
      {children}
    </code>
  )
}

function TodoLink({ id, fallback }: { id: string; fallback?: React.ReactNode }) {
  const knownPrefixes = useKnownTodoPrefixes()
  if (!isTodoId(id) || !knownPrefixes.has(id.slice(0, 3))) return fallback ?? id
  return (
    <Link
      to={todoPath(id)}
      title={`Open ${id}`}
      className="text-[var(--system-blue)] underline decoration-[var(--system-blue)]/40 hover:decoration-[var(--system-blue)] underline-offset-2 font-[family-name:var(--font-code)] text-[0.88em]"
    >
      {id}
    </Link>
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
      parts.push(<strong key={match.index} className="font-[var(--weight-bold)]">{inlineFormat(match[5])}</strong>)
    } else if (match[6]) {
      // Inline `code` — but if it's actually a file path, make it a viewer link.
      // Agents almost always wrap paths in backticks, so this is the common case.
      if (isFilePath(match[7])) {
        parts.push(renderPathLink(match[7], match.index))
      } else if (isTodoId(match[7])) {
        parts.push(<TodoLink key={match.index} id={match[7]} fallback={<InlineCode>{match[7]}</InlineCode>} />)
      } else {
        parts.push(<InlineCode key={match.index}>{match[7]}</InlineCode>)
      }
    } else if (match[8]) {
      parts.push(<em key={match.index} className="italic opacity-[0.85]">{inlineFormat(match[8])}</em>)
    } else if (match[9]) {
      // Bare (un-backticked) file path → viewer link
      parts.push(renderPathLink(match[9], match.index))
    } else if (match[10]) {
      parts.push(<TodoLink key={match.index} id={match[10]} />)
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
  return (
    <CodeBlockChrome key={keyProp} code={code} language={lang} className="my-[var(--space-2)]">
      <pre className="code-block overflow-x-auto py-[var(--space-3)] px-[var(--space-4)] text-[length:var(--text-footnote)] leading-normal font-[family-name:var(--font-code)] text-[var(--text-primary)]"><code>{code}</code></pre>
    </CodeBlockChrome>
  )
}

/* ── Reasoning trace tags ───────────────────────────────── */

// Some engines leak their scratchpad tags into the visible answer. Rendering the
// raw `<analysis>` line is worse than useless, and dropping the content would lose
// real text — so fold it into a collapsed disclosure instead.
// `summary` is here because a leaked compaction message is `<analysis>…</analysis>`
// followed by `<summary>…</summary>` — folding only the first half still dumps the
// whole recap into the chat.
const TRACE_TAGS = new Set(['analysis', 'thinking', 'reasoning', 'reflection', 'scratchpad', 'summary'])
const TRACE_OPEN_RE = /^<([a-z_]+)>$/i
const TRACE_CLOSE_RE = /^<\/([a-z_]+)>$/i

function TraceBlock({ tag, body }: { tag: string; body: string }) {
  const [open, setOpen] = useState(false)
  const label = tag.charAt(0).toUpperCase() + tag.slice(1)
  if (!body.trim()) return null
  return (
    <div className="my-[var(--space-2)]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-[var(--space-1)] rounded-[var(--radius-sm)] border-none bg-transparent px-0 py-px text-[length:var(--text-caption1)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)] cursor-pointer"
      >
        <ChevronDown size={12} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
        {label}
      </button>
      {open && (
        <div className="mt-[var(--space-1)] border-l-2 border-[var(--fill-tertiary)] pl-[var(--space-3)] text-[var(--text-secondary)]">
          {formatMessage(body)}
        </div>
      )}
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

export function formatMessage(content: string): React.ReactNode {
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

    // Reasoning trace tag on its own line: fold everything up to the closing tag
    // (or to the end of the message, so a mid-stream block folds too).
    const traceOpen = line.trim().match(TRACE_OPEN_RE)
    if (traceOpen && TRACE_TAGS.has(traceOpen[1].toLowerCase())) {
      const tag = traceOpen[1].toLowerCase()
      const traceLines: string[] = []
      let j = i + 1
      while (j < lines.length && lines[j].trim().toLowerCase() !== `</${tag}>`) {
        traceLines.push(lines[j])
        j++
      }
      result.push(<TraceBlock key={`trace-${i}`} tag={tag} body={traceLines.join('\n')} />)
      i = j // land on the closing tag (or end); the loop's i++ moves past it
      continue
    }
    // Stray closing tag with no opener — swallow it rather than print it raw.
    const traceClose = line.trim().match(TRACE_CLOSE_RE)
    if (traceClose && TRACE_TAGS.has(traceClose[1].toLowerCase())) continue

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
