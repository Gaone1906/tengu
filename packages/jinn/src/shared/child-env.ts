export interface EngineChildEnvOptions {
  scrubClaudeCode?: boolean;
  scrubCodex?: boolean;
  denyExact?: Iterable<string>;
}

const ENGINE_CHILD_ENV_DENY_EXACT: ReadonlySet<string> = new Set([
  "JINN_TAKE_PORT",
]);

export function buildEngineChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: EngineChildEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const denyExact = new Set(options.denyExact ?? []);
  for (const [key, value] of Object.entries(baseEnv)) {
    if (shouldScrubEngineChildEnv(key, options, denyExact)) continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function shouldScrubEngineChildEnv(
  key: string,
  options: EngineChildEnvOptions,
  denyExact: ReadonlySet<string>,
): boolean {
  if (ENGINE_CHILD_ENV_DENY_EXACT.has(key) || denyExact.has(key)) return true;
  if (options.scrubClaudeCode && (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_"))) return true;
  if (options.scrubCodex && (key === "CODEX" || key.startsWith("CODEX_"))) return true;
  return false;
}
