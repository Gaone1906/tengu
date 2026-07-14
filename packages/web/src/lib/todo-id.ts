const TODO_ID_PATTERN = /^[A-Z]{3}-([1-9][0-9]*)$/

export function deriveTodoIdPrefix(companyName: unknown): string | null {
  if (typeof companyName !== "string") return null
  const letters = companyName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
  return letters.length >= 3 ? letters.slice(0, 3) : null
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
