export const TODO_ID_PATTERN = /^([A-Z]{3})-([1-9][0-9]*)$/;
export const TODO_ID_PREFIX_PATTERN = /^[A-Z]{3}$/;

export class InvalidTodoIdError extends Error {
  constructor() {
    super("Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix");
    this.name = "InvalidTodoIdError";
  }
}

export class InvalidCompanyNameError extends Error {
  constructor() {
    super("Invalid company name; at least three Latin letters are required for Todo IDs");
    this.name = "InvalidCompanyNameError";
  }
}

/** Derive the stable public prefix from the first three normalized Latin letters. */
export function deriveTodoIdPrefix(companyName: unknown): string {
  if (typeof companyName !== "string") throw new InvalidCompanyNameError();
  const letters = companyName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (letters.length < 3) throw new InvalidCompanyNameError();
  return letters.slice(0, 3);
}

/** Parse the one Todo identity grammar without trimming or coercion. */
export function parseTodoId(value: unknown): string {
  if (typeof value !== "string") throw new InvalidTodoIdError();
  const match = TODO_ID_PATTERN.exec(value);
  if (!match) throw new InvalidTodoIdError();
  const ordinal = Number(match[2]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || String(ordinal) !== match[2]) {
    throw new InvalidTodoIdError();
  }
  return value;
}

export function todoIdOrdinal(value: unknown): number {
  const id = parseTodoId(value);
  return Number(TODO_ID_PATTERN.exec(id)![2]);
}

export function todoIdPrefix(value: unknown): string {
  const id = parseTodoId(value);
  return TODO_ID_PATTERN.exec(id)![1];
}

export function formatTodoId(prefix: string, ordinal: number): string {
  if (!TODO_ID_PREFIX_PATTERN.test(prefix) || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new InvalidTodoIdError();
  }
  return `${prefix}-${ordinal}`;
}

export function isTodoId(value: unknown): value is string {
  try {
    parseTodoId(value);
    return true;
  } catch {
    return false;
  }
}
