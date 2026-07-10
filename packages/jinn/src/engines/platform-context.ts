import { createHash } from "node:crypto";
import type { EngineRunOpts } from "../shared/types.js";
import {
  renderPlatformConfigContext,
  renderPlatformSessionContext,
  type PlatformContextSnapshot,
} from "../sessions/context.js";

export const PLATFORM_CONTEXT_REFRESH_HEADING = "## Jinn platform context refresh";

export function buildPromptWithPlatformContext(
  opts: Pick<EngineRunOpts, "prompt" | "systemPrompt" | "resumeSessionId" | "platformContextRefresh">,
  freshSeparator = "\n\n",
): string {
  if (!opts.resumeSessionId) {
    return opts.systemPrompt ? `${opts.systemPrompt}${freshSeparator}${opts.prompt}` : opts.prompt;
  }
  return opts.platformContextRefresh
    ? `${opts.platformContextRefresh}\n\n${opts.prompt}`
    : opts.prompt;
}

export function buildPlatformContextRefresh(snapshot: PlatformContextSnapshot): string {
  return [
    PLATFORM_CONTEXT_REFRESH_HEADING,
    "This replaces any stale platform/session metadata in the resumed transcript. Use these IDs/URLs for this turn and for any gateway API calls.",
    "",
    renderPlatformSessionContext(snapshot),
    renderPlatformConfigContext(snapshot),
  ].join("\n");
}

function sortStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStructured);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortStructured(entry)]),
  );
}

export function fingerprintPlatformContext(snapshot: PlatformContextSnapshot): string {
  const canonical = JSON.stringify(sortStructured(snapshot));
  return createHash("sha256").update(canonical).digest("hex");
}
