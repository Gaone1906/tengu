import type { Employee } from "./types.js";
import { JINN_HOME } from "./paths.js";

// The one function every session cwd call site must go through (docs/tengu/18-council-specialists.md finding 1).
export function resolveSessionCwd(employee?: Employee): string {
  return employee?.repo ?? JINN_HOME;
}
