import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type PollExecutableArtifactRole = 'shell' | 'executable' | 'interpreter' | 'script';

export interface PollExecutableArtifact {
  role: PollExecutableArtifactRole;
  path: string;
  sha256: string;
}

interface ArtifactStatKey {
  key: string;
  resolvedPath: string;
}

const hashCache = new Map<string, string>();
const CONTROL_OPERATORS = new Set([';', '&', '&&', '|', '||', '\n']);
const SHELL_RESERVED_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', '{', '}', '!',
]);
const INTERPRETER_NAMES = new Set([
  'bash', 'bun', 'deno', 'fish', 'node', 'nodejs', 'perl', 'php', 'python',
  'python2', 'python3', 'ruby', 'sh', 'zsh',
]);
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '--evaluate', '--command']);

function artifactStatKey(file: string): ArtifactStatKey {
  const resolvedPath = fs.realpathSync(file);
  const stat = fs.statSync(resolvedPath, { bigint: true });
  if (!stat.isFile()) throw new Error(`poll executable artifact is not a file: ${resolvedPath}`);
  return {
    resolvedPath,
    key: [resolvedPath, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('\0'),
  };
}

function hashFile(file: string): { path: string; sha256: string } {
  const stat = artifactStatKey(file);
  let sha256 = hashCache.get(stat.key);
  if (!sha256) {
    sha256 = crypto.createHash('sha256').update(fs.readFileSync(stat.resolvedPath)).digest('hex');
    hashCache.set(stat.key, sha256);
  }
  return { path: stat.resolvedPath, sha256 };
}

function resolveExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`poll executable could not be resolved on PATH: ${command}`);
}

function shellExecutable(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return env.ComSpec || env.COMSPEC || 'cmd.exe';
  return '/bin/sh';
}

/**
 * Tokenize only enough shell syntax to identify executable inputs. Quoted text is
 * kept as one word and control operators split commands. Expansion in a command
 * position is rejected later instead of guessed, because approval must fail closed.
 */
function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => {
    if (word) tokens.push(word);
    word = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\n') {
      flush();
      tokens.push('\n');
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|') {
      flush();
      const doubled = command[i + 1] === ch && ch !== ';';
      tokens.push(doubled ? `${ch}${ch}` : ch);
      if (doubled) i++;
      continue;
    }
    word += ch;
  }
  if (escaped || quote) throw new Error('poll command has an unterminated escape or quote');
  flush();
  return tokens;
}

function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokenizeShell(command)) {
    if (CONTROL_OPERATORS.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function addArtifact(
  artifacts: PollExecutableArtifact[],
  seen: Set<string>,
  role: PollExecutableArtifactRole,
  file: string,
): string {
  const hashed = hashFile(file);
  const key = `${role}\0${hashed.path}`;
  if (!seen.has(key)) {
    seen.add(key);
    artifacts.push({ role, ...hashed });
  }
  return hashed.path;
}

function maybeAddShebangInterpreter(
  artifacts: PollExecutableArtifact[],
  seen: Set<string>,
  executablePath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const fd = fs.openSync(executablePath, 'r');
  try {
    const buf = Buffer.alloc(512);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0];
    if (!firstLine.startsWith('#!')) return;
    const shebang = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
    if (!shebang.length) return;
    const interpreter = addArtifact(artifacts, seen, 'interpreter', resolveExecutable(shebang[0], cwd, env));
    if (path.basename(interpreter) === 'env') {
      const delegated = shebang.slice(1).find((part) => !part.startsWith('-'));
      if (delegated) addArtifact(artifacts, seen, 'interpreter', resolveExecutable(delegated, cwd, env));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function scriptArgument(tokens: string[], executablePath: string): string | undefined {
  const name = path.basename(executablePath).replace(/\.exe$/i, '').toLowerCase();
  if (!INTERPRETER_NAMES.has(name)) return undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (INLINE_CODE_FLAGS.has(token)) return undefined;
    if (token === '--') return tokens[i + 1];
    if (!token.startsWith('-')) return token;
    if ((token === '-r' || token === '--require' || token === '-m') && tokens[i + 1]) i++;
  }
  return undefined;
}

export function snapshotPollExecutableArtifacts(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): PollExecutableArtifact[] {
  const artifacts: PollExecutableArtifact[] = [];
  const seen = new Set<string>();
  addArtifact(artifacts, seen, 'shell', resolveExecutable(shellExecutable(opts.env), opts.cwd, opts.env));

  for (const rawSegment of commandSegments(command)) {
    const segment = [...rawSegment];
    while (segment[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[0])) segment.shift();
    while (segment[0] && SHELL_RESERVED_WORDS.has(segment[0])) segment.shift();
    if (!segment.length) continue;
    if (segment[0].includes('$') || segment[0].includes('`')) {
      throw new Error(`poll executable uses dynamic shell expansion and cannot be pinned: ${segment[0]}`);
    }
    if (segment[0] === '.' || segment[0] === 'source') {
      const script = segment[1];
      if (!script) throw new Error('poll source command is missing its script path');
      addArtifact(artifacts, seen, 'script', path.isAbsolute(script) ? script : path.resolve(opts.cwd, script));
      continue;
    }
    const executablePath = addArtifact(
      artifacts,
      seen,
      'executable',
      resolveExecutable(segment[0], opts.cwd, opts.env),
    );
    maybeAddShebangInterpreter(artifacts, seen, executablePath, opts.cwd, opts.env);
    const script = scriptArgument(segment, executablePath);
    if (script) {
      const scriptPath = path.isAbsolute(script) ? script : path.resolve(opts.cwd, script);
      if (fs.existsSync(scriptPath) && fs.statSync(scriptPath).isFile()) {
        addArtifact(artifacts, seen, 'script', scriptPath);
      }
    }
  }

  return artifacts.sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path));
}

export function resetPollArtifactHashCacheForTests(): void {
  hashCache.clear();
}
