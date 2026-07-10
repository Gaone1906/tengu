/**
 * Derive the compact role already exposed on roster API rows from an employee
 * persona. Keep this pure helper shared so prompt orientation and API discovery
 * describe employees with the same bounded text.
 */
export function compactEmployeeRole(persona?: string): string | undefined {
  const firstLine = persona
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;

  let role = firstLine
    .replace(/^\s*(?:#{1,6}\s*)?(?:[-*+]\s+|\d+\.\s+|>\s*)?/, "")
    .replace(/^you\s+are\s+(?:an?\s+|the\s+)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!role) return undefined;

  role = role.split(/\s+/).slice(0, 12).join(" ");
  if (role.length > 72) {
    const capped = role.slice(0, 72).replace(/\s+\S*$/, "").trim();
    role = capped || role.slice(0, 72).trim();
  }
  role = role.replace(/\.$/, "").trim();
  return role || undefined;
}
