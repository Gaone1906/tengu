const TODO_ID_PATTERN = /^[A-Z]{3}-([1-9][0-9]*)$/
const TODO_ID_PREFIX_PATTERN = /^[A-Z]{3}$/

export const TODO_ID_MENTION_SOURCE = String.raw`(?<![A-Za-z0-9-])[A-Z]{3}-[1-9][0-9]*(?![\w.-])`

export function deriveTodoIdPrefix(companyName: unknown): string | null {
  if (typeof companyName !== "string") return null
  const parts = companyName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[\s.\/&-]+/)
    .map((part) => part.toUpperCase().replace(/[^A-Z]/g, ""))
    .filter(Boolean)
  const prefix = parts.length >= 3
    ? parts.slice(0, 3).map((part) => part[0]).join("")
    : parts.length === 2 && parts[0].length < 3
      ? `${parts[0]}${parts[1]}`.slice(0, 3)
      : parts[0]?.slice(0, 3) ?? ""
  return TODO_ID_PREFIX_PATTERN.test(prefix) ? prefix : null
}

export function resolveTodoIdPrefix(companyName: unknown, override?: unknown): string | null {
  if (override !== undefined) {
    return typeof override === "string" && TODO_ID_PREFIX_PATTERN.test(override) ? override : null
  }
  return deriveTodoIdPrefix(companyName)
}

export function isTodoId(value: unknown): value is string {
  if (typeof value !== "string") return false
  const match = TODO_ID_PATTERN.exec(value)
  if (!match) return false
  const ordinal = Number(match[1])
  return Number.isSafeInteger(ordinal) && ordinal > 0
}

export function todoPath(id: string): string {
  return isTodoId(id) ? `/todos/${id}` : "/todos"
}
