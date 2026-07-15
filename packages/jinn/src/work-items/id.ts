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

export class InvalidTodoIdPrefixError extends Error {
  constructor() {
    super("Invalid Todo prefix; expected exactly three uppercase Latin letters");
    this.name = "InvalidTodoIdPrefixError";
  }
}

function normalizedCompanyParts(companyName: unknown): string[] {
  if (typeof companyName !== "string") throw new InvalidCompanyNameError();
  return companyName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[\s.\/&-]+/)
    .map((part) => part.toUpperCase().replace(/[^A-Z]/g, ""))
    .filter(Boolean);
}

/**
 * Derive the prefix a person would naturally pick: initials for three or more
 * word-ish parts, and the leading word for one or two parts. A short leading
 * acronym is completed by the following part (`IC-IDEV` -> `ICI`).
 */
export function deriveTodoIdPrefix(companyName: unknown): string {
  const parts = normalizedCompanyParts(companyName);
  let prefix: string;
  if (parts.length >= 3) {
    prefix = parts.slice(0, 3).map((part) => part[0]).join("");
  } else if (parts.length === 2 && parts[0].length < 3) {
    prefix = `${parts[0]}${parts[1]}`.slice(0, 3);
  } else {
    prefix = parts[0]?.slice(0, 3) ?? "";
  }
  if (prefix.length !== 3) throw new InvalidCompanyNameError();
  return prefix;
}

export function parseTodoIdPrefix(value: unknown): string {
  if (typeof value !== "string" || !TODO_ID_PREFIX_PATTERN.test(value)) {
    throw new InvalidTodoIdPrefixError();
  }
  return value;
}

export function resolveTodoIdPrefix(companyName: unknown, override?: unknown): string {
  return override === undefined ? deriveTodoIdPrefix(companyName) : parseTodoIdPrefix(override);
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
