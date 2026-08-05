import fs from "node:fs";
import path from "node:path";
import { resolveHostDataDir, type HostPathOptions } from "../instances/directory.js";

export interface SharedSttSettings {
  enabled?: boolean;
  model?: string;
  languages?: string[];
}

export interface LocalSttSettings extends SharedSttSettings {
  language?: string;
}

export interface EffectiveSttSettings {
  enabled?: boolean;
  model: string;
  languages: string[];
}

export type SharedSttSettingsReadResult =
  | { state: "missing" }
  | { state: "loaded"; settings: SharedSttSettings }
  | { state: "unreadable" };

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveSttSettingsPath(options: HostPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return env.JINN_STT_SETTINGS || pathApi(platform).join(resolveHostDataDir(options), "stt.json");
}

function parseSharedSttSettings(value: unknown): SharedSttSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const settings: SharedSttSettings = {};

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error("enabled must be a boolean");
    settings.enabled = raw.enabled;
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !raw.model.trim()) throw new Error("model must be a non-empty string");
    settings.model = raw.model;
  }
  if (raw.languages !== undefined) {
    if (!Array.isArray(raw.languages) || raw.languages.some((language) => typeof language !== "string")) {
      throw new Error("languages must be an array of strings");
    }
    settings.languages = [...raw.languages] as string[];
  }

  return settings;
}

function settingsFromLocal(localSettings: LocalSttSettings): SharedSttSettings {
  const settings = parseSharedSttSettings(localSettings);
  if ((!settings.languages || settings.languages.length === 0)
    && typeof localSettings.language === "string"
    && localSettings.language) {
    settings.languages = [localSettings.language];
  }
  return settings;
}

export function readSharedSttSettings(
  settingsPath: string,
  warn: (message: string) => void = (message) => console.warn(message),
): SharedSttSettingsReadResult {
  try {
    return {
      state: "loaded",
      settings: parseSharedSttSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8"))),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    warn(`Could not read shared STT settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { state: "unreadable" };
  }
}

export function seedSharedSttSettings(
  settingsPath: string,
  localSettings?: LocalSttSettings,
): void {
  if (!localSettings) return;
  const settings = settingsFromLocal(localSettings);
  if (Object.keys(settings).length === 0) return;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  try {
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function writeSharedSttSettings(
  settingsPath: string,
  settings: SharedSttSettings,
): void {
  const normalized = parseSharedSttSettings(settings);
  const tmpPath = `${settingsPath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, settingsPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file was not created */ }
    throw error;
  }
}

export function resolveEffectiveSttSettings(
  sharedSettings: SharedSttSettingsReadResult,
  localSettings?: LocalSttSettings,
): EffectiveSttSettings {
  const source = sharedSettings.state === "loaded"
    ? parseSharedSttSettings(sharedSettings.settings)
    : sharedSettings.state === "missing" && localSettings
      ? settingsFromLocal(localSettings)
      : {};
  return {
    ...(source.enabled !== undefined ? { enabled: source.enabled } : {}),
    model: source.model || "small",
    languages: source.languages && source.languages.length > 0 ? [...source.languages] : ["en"],
  };
}

export function getEffectiveSttSettings(
  localSettings?: LocalSttSettings,
  settingsPath = resolveSttSettingsPath(),
  warn: (message: string) => void = (message) => console.warn(message),
): EffectiveSttSettings {
  return resolveEffectiveSttSettings(readSharedSttSettings(settingsPath, warn), localSettings);
}
