import type { EngineRunOpts } from "../shared/types.js";

export const PLATFORM_CONTEXT_REFRESH_HEADING = "## Jinn platform context refresh";

export function buildPromptWithPlatformContext(
  opts: Pick<EngineRunOpts, "prompt" | "systemPrompt" | "resumeSessionId">,
  freshSeparator = "\n\n",
): string {
  if (!opts.systemPrompt) return opts.prompt;
  if (!opts.resumeSessionId) return `${opts.systemPrompt}${freshSeparator}${opts.prompt}`;

  const refresh = buildResumePlatformRefresh(opts.systemPrompt);
  return refresh ? `${refresh}\n\n${opts.prompt}` : opts.prompt;
}

export function buildResumePlatformRefresh(systemPrompt: string): string {
  const sections = [
    extractMarkdownSection(systemPrompt, "## Current session"),
    extractMarkdownSection(systemPrompt, "## Current configuration"),
  ].filter((section): section is string => Boolean(section));

  if (sections.length === 0) return "";
  return [
    PLATFORM_CONTEXT_REFRESH_HEADING,
    "This replaces any stale platform/session metadata in the resumed transcript. Use these IDs/URLs for this turn and for any gateway API calls.",
    "",
    ...sections,
  ].join("\n");
}

function extractMarkdownSection(markdown: string, heading: string): string | null {
  const start = markdown.indexOf(heading);
  if (start === -1) return null;
  const rest = markdown.slice(start);
  const next = rest.slice(heading.length).search(/^##\s/m);
  const section = next === -1 ? rest : rest.slice(0, heading.length + next);
  return section.trim() || null;
}
