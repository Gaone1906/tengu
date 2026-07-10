import os from "node:os";
import path from "node:path";

/** Resolve the current instance home at call time, before eager path constants. */
export function resolveJinnHome(): string {
  if (process.env.JINN_HOME) return path.resolve(process.env.JINN_HOME);
  const instance = process.env.JINN_INSTANCE || "jinn";
  return path.resolve(path.join(os.homedir(), `.${instance}`));
}

/** Resolve the durable per-instance key without freezing JINN_HOME at import. */
export function resolveMcpSessionCapabilityKeyFile(jinnHome = resolveJinnHome()): string {
  return path.join(jinnHome, "secrets", "mcp-session-capability.key");
}
