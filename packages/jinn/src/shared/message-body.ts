/**
 * One definition of "this send carries no instruction", for the HTTP routes that
 * accept caller-authored message text (session spawn, session message, and the
 * lateral agent-to-agent send inside it). Those routes already refused an absent
 * body; a body of nothing but whitespace slipped through and reached an engine as
 * a turn with nothing in it.
 *
 * Emptiness here means absent or whitespace-only, and nothing else. A body of
 * "- " is one character of real content — deciding it is too little would make
 * the gateway an arbiter of which characters count as an instruction.
 *
 * Returns the caller-facing error, or undefined when the body is acceptable.
 */
export function messageBodyError(text: unknown, field = "message"): string | undefined {
  if (typeof text !== "string" || text.length === 0) return `${field} is required`;
  if (text.trim().length === 0) return `${field} is empty — a turn needs at least one non-whitespace character`;
  return undefined;
}
