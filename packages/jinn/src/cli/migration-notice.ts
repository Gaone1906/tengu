import type { PendingInstanceMigration } from "../migrations/service.js"

const ANSI = {
  violet: "\u001b[35m",
  amber: "\u001b[33m",
  cyan: "\u001b[36m",
  reset: "\u001b[0m",
}

export interface MigrationNoticeOptions {
  isTTY?: boolean
  color?: boolean
  unicode?: boolean
  columns?: number
}

export function migrationNoticeOptionsForProcess(options: {
  isTTY: boolean
  columns?: number
  env: Record<string, string | undefined>
  daemon: boolean
}): MigrationNoticeOptions {
  return {
    isTTY: options.isTTY && !options.daemon,
    color: !("NO_COLOR" in options.env),
    unicode: options.env.TERM !== "dumb",
    columns: options.columns,
  }
}

export function shouldUseMigrationNoticeColor(options: Pick<MigrationNoticeOptions, "isTTY" | "color">): boolean {
  return Boolean(options.isTTY && (options.color ?? true))
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (!line) line = word
    else if (line.length + word.length + 1 <= width) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines
}

export function renderMigrationNotice(
  migration: PendingInstanceMigration,
  options: MigrationNoticeOptions = {},
): { notice: string | null; prompt: string | null } {
  if (!migration.required) return { notice: null, prompt: null }
  const isTTY = options.isTTY ?? false
  const useColor = shouldUseMigrationNoticeColor({ isTTY, color: options.color })
  const unicode = options.unicode ?? true
  const columns = Math.max(32, Math.min(options.columns ?? 72, 92))
  const inner = columns - 4
  const border = unicode
    ? { topLeft: "╭", horizontal: "─", topJoin: "─", topRight: "╮", vertical: "│", bottomLeft: "╰", bottomRight: "╯" }
    : { topLeft: "+", horizontal: "-", topJoin: "-", topRight: "+", vertical: "|", bottomLeft: "+", bottomRight: "+" }
  const heading = "Jinn update installed"
  const versionArrow = unicode ? "→" : "->"
  const topRule = `${border.topLeft}${border.topJoin} ${heading} ${border.horizontal.repeat(Math.max(1, columns - heading.length - 5))}${border.topRight}`
  const body = [
    ...wrap(`v${migration.fromVersion} ${versionArrow} v${migration.toVersion} needs one safe setup merge.`, inner),
    ...wrap("Your custom files are preserved.", inner),
    ...wrap("Open the dashboard or hand the prompt below to your COO.", inner),
  ]
  const pad = (line: string) => `${border.vertical} ${line}${" ".repeat(Math.max(0, inner - line.length))} ${border.vertical}`
  const bottom = `${border.bottomLeft}${border.horizontal.repeat(columns - 2)}${border.bottomRight}`
  const plain = [topRule, ...body.map(pad), bottom]
  if (!useColor) return { notice: plain.join("\n"), prompt: isTTY ? migration.prompt : null }
  const colored = [
    `${ANSI.violet}${plain[0]}${ANSI.reset}`,
    `${ANSI.amber}${plain[1]}${ANSI.reset}`,
    ...plain.slice(2, -2),
    `${ANSI.cyan}${plain.at(-2)}${ANSI.reset}`,
    `${ANSI.violet}${plain.at(-1)}${ANSI.reset}`,
  ]
  return { notice: colored.join("\n"), prompt: migration.prompt }
}
