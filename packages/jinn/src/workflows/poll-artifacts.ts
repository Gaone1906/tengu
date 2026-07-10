import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type PollExecutableArtifactRole = 'shell' | 'executable' | 'interpreter' | 'script';

export interface PollExecutableArtifact {
  role: PollExecutableArtifactRole;
  path: string;
  sha256: string;
}

export interface StagedPollCommand {
  executablePath: string;
  interpreterPath: string;
}

export interface OpenStagedPollCommand extends StagedPollCommand {
  executableFd: number;
}

const PINNABLE_GUIDANCE = 'poll command is not a fully pinnable poll command; use a single absolute path to an executable static poll script with no arguments';
const FORBIDDEN_COMMAND_CHARS = /[\s;&|<>`$\\*?\[\]{}()]/;
const STAGING_DIR = 'workflow-trigger-artifacts';

function rejectUnpinnable(reason: string): never {
  throw new Error(`${PINNABLE_GUIDANCE} (${reason})`);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isGatewayOwned(stat: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function privateStagingRoot(cwd: string): string {
  const root = path.resolve(cwd, STAGING_DIR);
  return fs.existsSync(root) ? fs.realpathSync(root) : root;
}

function ensurePrivateStagingRoot(cwd: string): string {
  const root = privateStagingRoot(cwd);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isGatewayOwned(stat)) {
    throw new Error('poll artifact staging root is not a private directory');
  }
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
}

function resolveSourceCommand(command: string): string {
  if (process.platform === 'win32') rejectUnpinnable('static poll scripts are not supported on this platform');
  if (!command || command !== command.trim()) rejectUnpinnable('command must not contain surrounding whitespace');
  if (!path.isAbsolute(command)) rejectUnpinnable('PATH lookup and relative paths are not allowed');
  if (FORBIDDEN_COMMAND_CHARS.test(command)) rejectUnpinnable('arguments, shell syntax, expansion, and indirection are not allowed');
  try {
    fs.accessSync(command, fs.constants.X_OK);
    const resolved = fs.realpathSync(command);
    if (!fs.statSync(resolved).isFile()) rejectUnpinnable('the absolute script path must resolve to a regular file');
    return resolved;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(PINNABLE_GUIDANCE)) throw err;
    rejectUnpinnable('the absolute script path must resolve to an executable file');
  }
}

function inspectPinnableScriptBytes(bytes: Buffer): string {
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes) || source.includes('\0') || source.includes('\r')) {
    rejectUnpinnable('script encoding is not supported');
  }
  const newline = source.indexOf('\n');
  if (newline < 0 || !source.startsWith('#!')) rejectUnpinnable('script must have a pinned absolute interpreter');
  const interpreter = source.slice(2, newline);
  if (!path.isAbsolute(interpreter) || /\s/.test(interpreter)) {
    rejectUnpinnable('interpreter must be one absolute path with no options or delegation');
  }

  let interpreterPath: string;
  try {
    interpreterPath = fs.realpathSync(interpreter);
  } catch {
    rejectUnpinnable('interpreter path cannot be resolved');
  }
  if (interpreterPath !== fs.realpathSync('/bin/sh')) {
    rejectUnpinnable('only the constrained system shell script format is supported');
  }

  const body = source.slice(newline + 1).replace(/\n$/, '');
  const staticOutput = /^printf '%s' '[^'\n]*'$/.test(body);
  const fixedExit = /^exit (?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(body);
  const fixedBusyLoop = body === 'while :; do :; done';
  if (!staticOutput && !fixedExit && !fixedBusyLoop) {
    rejectUnpinnable('script body is outside the static poll allowlist');
  }
  return interpreterPath;
}

function writePrivateFile(file: string, bytes: Buffer): void {
  const fd = fs.openSync(file, 'wx', 0o500);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o500);
  } finally {
    fs.closeSync(fd);
  }
}

function openVerifiedPrivateFile(file: string, expectedHash: string, root: string): { path: string; fd: number } {
  const absolute = path.resolve(file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('poll staged artifact escaped its private staging root');
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || !isGatewayOwned(stat) || (stat.mode & 0o777) !== 0o500) {
    throw new Error('poll staged artifact is not a read-only regular file');
  }
  if (fs.realpathSync(absolute) !== absolute) {
    throw new Error('poll staged artifact path is not canonical');
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('poll staged artifact changed while it was opened');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error('poll staged artifact could not be read completely');
      offset += read;
    }
    if (sha256(bytes) !== expectedHash) throw new Error('poll staged artifact hash changed');
    return { path: absolute, fd };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function verifyPrivateFile(file: string, expectedHash: string, root: string): string {
  const opened = openVerifiedPrivateFile(file, expectedHash, root);
  fs.closeSync(opened.fd);
  return opened.path;
}

function verifyTrustedInterpreter(file: string, expectedHash: string): string {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new Error('poll interpreter is not a canonical regular file');
  }
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error('poll interpreter is not a root-owned system executable');
  }
  if (sha256(fs.readFileSync(absolute)) !== expectedHash) {
    throw new Error('poll interpreter hash changed');
  }
  return absolute;
}

function materializeStagedScript(
  root: string,
  scriptBytes: Buffer,
  interpreterHash: string,
): PollExecutableArtifact {
  const scriptHash = sha256(scriptBytes);
  const pairHash = sha256(Buffer.from(`${scriptHash}\0${interpreterHash}`));
  const finalDir = path.join(root, pairHash);
  const executablePath = path.join(finalDir, 'poll-script');

  if (!fs.existsSync(finalDir)) {
    const tempDir = fs.mkdtempSync(path.join(root, `.${pairHash}.`));
    try {
      fs.chmodSync(tempDir, 0o700);
      writePrivateFile(path.join(tempDir, 'poll-script'), scriptBytes);
      try {
        fs.renameSync(tempDir, finalDir);
        fs.chmodSync(finalDir, 0o500);
      } catch (err) {
        if (!fs.existsSync(finalDir)) throw err;
      }
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.chmodSync(tempDir, 0o700);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  const dirStat = fs.lstatSync(finalDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !isGatewayOwned(dirStat) || (dirStat.mode & 0o777) !== 0o500) {
    throw new Error('poll artifact staging directory is not private');
  }
  fs.chmodSync(finalDir, 0o500);
  verifyPrivateFile(executablePath, scriptHash, root);
  return { role: 'executable', path: executablePath, sha256: scriptHash };
}

export function snapshotPollExecutableArtifacts(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): PollExecutableArtifact[] {
  void opts.env;
  const sourcePath = resolveSourceCommand(command);
  const scriptBytes = fs.readFileSync(sourcePath);
  const interpreterSourcePath = inspectPinnableScriptBytes(scriptBytes);
  const interpreterBytes = fs.readFileSync(interpreterSourcePath);
  const interpreterHash = sha256(interpreterBytes);
  return [
    materializeStagedScript(ensurePrivateStagingRoot(opts.cwd), scriptBytes, interpreterHash),
    { role: 'interpreter', path: interpreterSourcePath, sha256: interpreterHash },
  ];
}

function stagedArtifacts(
  artifacts: PollExecutableArtifact[],
  opts: { cwd: string },
): { root: string; executable: PollExecutableArtifact; interpreter: PollExecutableArtifact } {
  const root = privateStagingRoot(opts.cwd);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !isGatewayOwned(rootStat) || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error('poll artifact staging root is not private');
  }
  if (artifacts.length !== 2) throw new Error('poll activation contract does not contain exactly two staged artifacts');
  const executable = artifacts.find((artifact) => artifact.role === 'executable');
  const interpreter = artifacts.find((artifact) => artifact.role === 'interpreter');
  if (!executable || !interpreter) throw new Error('poll activation contract is missing a staged executable or interpreter');
  return { root, executable, interpreter };
}

export function verifyStagedPollExecutableArtifacts(
  artifacts: PollExecutableArtifact[],
  opts: { cwd: string },
): StagedPollCommand {
  const { root, executable, interpreter } = stagedArtifacts(artifacts, opts);
  const executablePath = verifyPrivateFile(executable.path, executable.sha256, root);
  const interpreterPath = verifyTrustedInterpreter(interpreter.path, interpreter.sha256);
  return { executablePath, interpreterPath };
}

export function openVerifiedStagedPollExecutableArtifacts(
  artifacts: PollExecutableArtifact[],
  opts: { cwd: string },
): OpenStagedPollCommand {
  const { root, executable, interpreter } = stagedArtifacts(artifacts, opts);
  const opened = openVerifiedPrivateFile(executable.path, executable.sha256, root);
  try {
    return {
      executablePath: opened.path,
      executableFd: opened.fd,
      interpreterPath: verifyTrustedInterpreter(interpreter.path, interpreter.sha256),
    };
  } catch (err) {
    fs.closeSync(opened.fd);
    throw err;
  }
}

function makeTreeRemovable(dir: string): void {
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) makeTreeRemovable(child);
    else if (!entry.isSymbolicLink()) fs.chmodSync(child, 0o600);
  }
}

export function cleanupStagedPollExecutableArtifacts(
  inUse: PollExecutableArtifact[],
  opts: { cwd: string },
): void {
  const root = privateStagingRoot(opts.cwd);
  if (!fs.existsSync(root)) return;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
  const referencedDirs = new Set(
    inUse
      .map((artifact) => path.dirname(path.resolve(artifact.path)))
      .filter((dir) => path.dirname(dir) === root),
  );
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    if (referencedDirs.has(dir)) continue;
    makeTreeRemovable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (fs.readdirSync(root).length === 0) fs.rmSync(root, { recursive: true, force: true });
}

export function resetPollArtifactHashCacheForTests(): void {
  // Kept for compatibility with existing test callers; staged verification is uncached.
}
