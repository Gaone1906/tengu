export const TODO_ID_PREFIX = "JIN";
export const TODO_ID_PATTERN = /^JIN-([1-9][0-9]*)$/;

export class InvalidTodoIdError extends Error {
  constructor() {
    super("Invalid Todo ID; expected JIN-N with a positive safe-integer suffix");
    this.name = "InvalidTodoIdError";
  }
}

/** Parse the one Todo identity grammar without trimming or coercion. */
export function parseTodoId(value: unknown): string {
  if (typeof value !== "string") throw new InvalidTodoIdError();
  const match = TODO_ID_PATTERN.exec(value);
  if (!match) throw new InvalidTodoIdError();
  const ordinal = Number(match[1]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || String(ordinal) !== match[1]) {
    throw new InvalidTodoIdError();
  }
  return value;
}

export function todoIdOrdinal(value: unknown): number {
  const id = parseTodoId(value);
  return Number(id.slice(TODO_ID_PREFIX.length + 1));
}

export function formatTodoId(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new InvalidTodoIdError();
  return `${TODO_ID_PREFIX}-${ordinal}`;
}

export function isTodoId(value: unknown): value is string {
  try {
    parseTodoId(value);
    return true;
  } catch {
    return false;
  }
}
