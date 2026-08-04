import fs from "node:fs";
import path from "node:path";
import { resolveHostDataDir, type HostPathOptions } from "../instances/directory.js";

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveSttModelsDir(options: HostPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return env.JINN_STT_MODELS_DIR || pathApi(platform).join(
    resolveHostDataDir(options),
    "models",
    "whisper",
  );
}

export function findModelFile(filename: string, directories: readonly string[]): string | null {
  for (const directory of directories) {
    const candidate = path.join(directory, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface AdoptLegacyModelsOptions {
  sharedDir: string;
  legacyDir: string;
  filenames: readonly string[];
}

function isMissingOrUnreadable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

export function adoptLegacyModels(options: AdoptLegacyModelsOptions): string[] {
  let legacyEntries: Set<string>;
  try {
    legacyEntries = new Set(fs.readdirSync(options.legacyDir));
  } catch (error) {
    if (isMissingOrUnreadable(error)) return [];
    throw error;
  }

  fs.mkdirSync(options.sharedDir, { recursive: true });
  const adopted: string[] = [];
  for (const filename of options.filenames) {
    if (!legacyEntries.has(filename)) continue;
    const source = path.join(options.legacyDir, filename);
    const destination = path.join(options.sharedDir, filename);
    if (fs.existsSync(destination)) continue;

    try {
      fs.renameSync(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
        if (isMissingOrUnreadable(error)) continue;
        throw error;
      }
      try {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.unlinkSync(source);
      } catch (copyError) {
        if (isMissingOrUnreadable(copyError) || (copyError as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw copyError;
      }
    }
    adopted.push(destination);
  }
  return adopted;
}
