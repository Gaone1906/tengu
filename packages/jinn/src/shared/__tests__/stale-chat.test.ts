import { describe, expect, it } from "vitest";
import { resolveStaleChatPolicy } from "../stale-chat.js";

describe("resolveStaleChatPolicy", () => {
  it("uses the enabled 300k token and 60 minute defaults", () => {
    expect(resolveStaleChatPolicy({ sessions: {} })).toEqual({
      enabled: true,
      tokenThreshold: 300_000,
      staleAfterMinutes: 60,
    });
  });

  it("preserves an explicit policy", () => {
    expect(resolveStaleChatPolicy({
      sessions: {
        staleChat: {
          enabled: false,
          tokenThreshold: 48_000,
          staleAfterMinutes: 15,
        },
      },
    })).toEqual({
      enabled: false,
      tokenThreshold: 48_000,
      staleAfterMinutes: 15,
    });
  });

  it("clamps thresholds to their minimums", () => {
    expect(resolveStaleChatPolicy({
      sessions: {
        staleChat: {
          tokenThreshold: 999,
          staleAfterMinutes: 0,
        },
      },
    })).toEqual({
      enabled: true,
      tokenThreshold: 1_000,
      staleAfterMinutes: 1,
    });
  });
});
