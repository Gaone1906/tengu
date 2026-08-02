// Control-byte hygiene for untrusted text. Two deliberately different policies:
// repair for display/search input, reject for security-critical path params.

/** Replace NUL and other non-printing control bytes with spaces (GRS-020a-fix
 *  finding 2). Shared by the FTS sanitizer and the search routes so hostile
 *  encoded input (%00 etc.) yields a normal result everywhere, never a 500. */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** True if the string carries a NUL or other non-printing control byte. The
 *  REJECT-don't-strip gate for security-critical PATH params (GRS-020b-fix):
 *  {@link stripControlChars} would silently REPAIR a `%00`-tampered path into a
 *  valid one, so the knowledge read surface rejects on the raw param instead. */
export function hasControlBytes(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}
