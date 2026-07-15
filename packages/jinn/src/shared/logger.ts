import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./paths.js";
import { redactText } from "./redact.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let minLevel: LogLevel = "info";
let writeToStdout = true;
let logStream: fs.WriteStream | null = null;

// Bound gateway.log growth: an unrotated log grew to 11MB+ and, on a full disk,
// was one of the writers that kept ENOSPC alive. Rotate at a fixed size and keep
// a single previous generation (gateway.log.1) — KISS, no external logrotate.
const MAX_LOG_BYTES = 25 * 1024 * 1024;
let logPath: string | null = null;
let logBytes = 0;

function rotateIfNeeded(nextChunkBytes: number) {
  if (!logStream || !logPath) return;
  if (logBytes + nextChunkBytes <= MAX_LOG_BYTES) return;
  const stream = logStream;
  logStream = null;
  stream.end();
  try {
    fs.renameSync(logPath, `${logPath}.1`); // overwrites the prior generation
  } catch {
    /* if rename fails (e.g. ENOSPC), fall through and reopen; truncation below */
  }
  logStream = fs.createWriteStream(logPath, { flags: "w" });
  logBytes = 0;
}

export function configureLogger(opts: {
  level?: string;
  stdout?: boolean;
  file?: boolean;
}) {
  if (opts.level && opts.level in LEVELS) minLevel = opts.level as LogLevel;
  if (opts.stdout !== undefined) writeToStdout = opts.stdout;
  if (opts.file !== false) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    logPath = path.join(LOGS_DIR, "gateway.log");
    try { logBytes = fs.statSync(logPath).size; } catch { logBytes = 0; }
    logStream = fs.createWriteStream(logPath, { flags: "a" });
  }
}

export function closeLogger(): Promise<void> {
  const stream = logStream;
  if (!stream) return Promise.resolve();
  logStream = null;
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}

function log(level: LogLevel, message: string) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const safeMessage = redactText(message);
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${safeMessage}`;
  if (writeToStdout) console.log(line);
  if (logStream) {
    const chunk = line + "\n";
    const bytes = Buffer.byteLength(chunk);
    rotateIfNeeded(bytes);
    if (logStream) {
      logStream.write(chunk);
      logBytes += bytes;
    }
  }
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};
