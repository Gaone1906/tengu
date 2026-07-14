const TODO_ID_PATTERN = /^JIN-([1-9][0-9]*)$/

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
