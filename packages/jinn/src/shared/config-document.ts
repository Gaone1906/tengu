// Surgical edits to config.yaml, through the YAML document API. One implementation
// because there were two — instances/create.ts and scripts/docker-configure.mjs — which
// had drifted on how the result is persisted, leaving config.yaml's permissions dependent
// on which path last touched it. The container no longer patches config.yaml at all.

import fs from "node:fs";
import YAML from "yaml";

export interface ConfigPatchEntry {
  /** Key path into the document, e.g. ["gateway", "host"]. */
  path: (string | number)[];
  /** New value. `undefined` means "leave this key alone" so callers can build the
   *  list unconditionally instead of pushing entries behind ifs. */
  value: unknown;
}

/** Distinguishable from a programming error so callers can report it to the operator
 *  rather than crash. `code` carries the fs errno when the read is what failed, which
 *  is how a caller tells "no config yet" (ENOENT) from "cannot read it" (EACCES). */
export class ConfigDocumentError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ConfigDocumentError";
    this.code = code;
  }
}

/**
 * Apply `entries` to the config at `configPath`, returning whether anything changed. The
 * document API rather than parse/dump, which would reformat a hand-edited, comment-heavy
 * file to change one key. No-op entries are skipped and writes are atomic and 0600: the
 * running gateway watches this file, and the auth token lives beside these keys.
 */
export function patchConfigFile(configPath: string, entries: ConfigPatchEntry[]): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigDocumentError(`cannot read ${configPath}: ${(err as Error).message}`, code);
  }

  const document = YAML.parseDocument(raw);
  if (document.errors.length) {
    throw new ConfigDocumentError(`${configPath} is not valid YAML: ${document.errors[0].message}`);
  }

  let changed = false;
  for (const { path, value } of entries) {
    if (value === undefined) continue;
    if (document.getIn(path) === value) continue;
    document.setIn(path, value);
    changed = true;
  }

  if (changed) writeConfigAtomic(configPath, document.toString({ lineWidth: 0 }));
  return changed;
}

function writeConfigAtomic(configPath: string, contents: string): void {
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  // rename carries the temp file's mode, but if the destination already existed with
  // broader permissions some filesystems keep the old inode's — be explicit.
  fs.chmodSync(configPath, 0o600);
}
