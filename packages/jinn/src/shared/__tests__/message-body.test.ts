import { describe, it, expect } from "vitest";
import { messageBodyError } from "../message-body.js";

describe("messageBodyError", () => {
  it("rejects an absent body as required", () => {
    expect(messageBodyError(undefined)).toBe("message is required");
    expect(messageBodyError(null)).toBe("message is required");
    expect(messageBodyError("")).toBe("message is required");
  });

  it("names the field the caller actually sent", () => {
    expect(messageBodyError(undefined, "prompt or message")).toBe("prompt or message is required");
  });

  it.each(["   ", "\n", "\t\t", "\n \r\n ", " "])("rejects the whitespace-only body %j", (text) => {
    expect(messageBodyError(text)).toBe("message is empty — a turn needs at least one non-whitespace character");
  });

  // The failure this guard came from was a prompt of "- ": one character of real
  // content. It is not empty, and trimming punctuation to call it empty would be
  // the gateway deciding which characters count as an instruction. It passes.
  it.each(["- ", "-", ".", "?", "ok", " hi "])("accepts %j as real content", (text) => {
    expect(messageBodyError(text)).toBeUndefined();
  });

  it("rejects a non-string body rather than coercing it", () => {
    expect(messageBodyError(42)).toBe("message is required");
    expect(messageBodyError({})).toBe("message is required");
  });
});
