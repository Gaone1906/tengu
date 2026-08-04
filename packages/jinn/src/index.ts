export type {
  Engine,
  EngineRunOpts,
  EngineResult,
  Connector,
  IncomingMessage,
  Attachment,
  Target,
  Session,
  CronJob,
  CronDelivery,
  Employee,
  Department,
  JinnConfig,
} from "./shared/types.js";

export { loadConfig } from "./shared/config.js";
export { configureLogger, logger } from "./shared/logger.js";

// The surface scripts/docker-configure.mjs runs against — loadConfig above plus these,
// which is exactly what that script destructures. It runs outside the package, and
// without a declared entry point it imported compiled internals by relative URL: paths
// scripts/build.mjs is free to move, so a rename broke the container, not the build.
export { resolveJinnHome, resolveClaudeConfigDir, claudeJsonPath } from "./shared/home.js";
export { isLoopbackHost } from "./gateway/auth.js";
export {
  JINN_HOME,
  CONFIG_PATH,
  SESSIONS_DB,
  CRON_JOBS,
  CRON_RUNS,
  ORG_DIR,
  SKILLS_DIR,
  DOCS_DIR,
  LOGS_DIR,
  TMP_DIR,
  PID_FILE,
  TEMPLATE_DIR,
} from "./shared/paths.js";
