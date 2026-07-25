import { assertIsolatedTestHome } from './vitest.test-home.js';

// setupFiles execute inside each worker before its test module is evaluated.
// Abort loudly if the pre-worker global setup ever stops propagating its home.
assertIsolatedTestHome(process.env.JINN_HOME);

/**
 * Scrub gateway/engine env that leaks in when the suite runs from inside a live
 * Jinn session — the common case on the operator's machine, where a Claude PTY
 * exports these into every child process.
 *
 * Same isolation boundary and same failure class as the JINN_HOME leak: the
 * test's result silently depends on WHO ran it. This one is not hypothetical —
 * it broke claude-interactive-compact-window.test.ts, whose "no proxy → no
 * first-party assertion" case failed on an inherited '1' from the enclosing PTY.
 *
 * JINN_HOME is deliberately NOT listed: global setup owns it, and it has
 * already been asserted above.
 */
const LEAKY_ENV_VARS = [
  // Claude Code PTY env injected by the gateway (engines/claude-interactive.ts).
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDECODE',
  'ANTHROPIC_BASE_URL',
  // Session identity — a test inheriting these could act as a real session.
  'JINN_SESSION_ID',
  'JINN_SESSION_CAPABILITY',
  'JINN_GATEWAY_URL',
  'JINN_GATEWAY_TOKEN',
  'JINN_HOME_IDENTITY',
  // Engine homes.
  'CODEX',
  'CODEX_HOME',
] as const;

for (const name of LEAKY_ENV_VARS) delete process.env[name];
