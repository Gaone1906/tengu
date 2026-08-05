import type { JinnConfig } from "./types.js";

export interface StaleChatPolicy {
  enabled: boolean;
  tokenThreshold: number;
  staleAfterMinutes: number;
}

const DEFAULT_STALE_CHAT_POLICY: StaleChatPolicy = {
  enabled: true,
  tokenThreshold: 300_000,
  staleAfterMinutes: 60,
};

function resolvedNumber(value: number | undefined, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, value);
}

export function resolveStaleChatPolicy(config: Pick<JinnConfig, "sessions">): StaleChatPolicy {
  const configured = config.sessions?.staleChat;
  return {
    enabled: configured?.enabled ?? DEFAULT_STALE_CHAT_POLICY.enabled,
    tokenThreshold: resolvedNumber(
      configured?.tokenThreshold,
      DEFAULT_STALE_CHAT_POLICY.tokenThreshold,
      1_000,
    ),
    staleAfterMinutes: resolvedNumber(
      configured?.staleAfterMinutes,
      DEFAULT_STALE_CHAT_POLICY.staleAfterMinutes,
      1,
    ),
  };
}
