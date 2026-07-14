import { describe, expect, it } from "vitest";
import {
  InvalidTodoIdError,
  deriveTodoIdPrefix,
  formatTodoId,
  parseTodoId,
  todoIdOrdinal,
  todoIdPrefix,
} from "../id.js";

describe("company-derived Todo identity", () => {
  it("derives the first three normalized ASCII letters from the company name", () => {
    expect(deriveTodoIdPrefix("IC-IDEV")).toBe("ICI");
    expect(deriveTodoIdPrefix("Acme Labs")).toBe("ACM");
    expect(deriveTodoIdPrefix("Éclair Works")).toBe("ECL");
    expect(deriveTodoIdPrefix("  one.two  ")).toBe("ONE");
  });

  it("rejects company names that cannot produce three ASCII letters", () => {
    for (const value of ["AI", "123", "東京", "", null, 42]) {
      expect(() => deriveTodoIdPrefix(value)).toThrow(/company name/i);
    }
  });

  it("parses and formats any canonical three-letter company prefix", () => {
    expect(parseTodoId("ICI-1")).toBe("ICI-1");
    expect(parseTodoId("ACM-9007199254740991")).toBe("ACM-9007199254740991");
    expect(todoIdPrefix("ICI-42")).toBe("ICI");
    expect(todoIdOrdinal("ICI-42")).toBe(42);
    expect(formatTodoId("ICI", 42)).toBe("ICI-42");
  });

  it("rejects malformed prefixes and ordinals", () => {
    for (const value of [
      "IC-1",
      "ICID-1",
      "ici-1",
      "I1I-1",
      "ICI-0",
      "ICI-01",
      "ICI-9007199254740992",
      " ICI-1",
    ]) {
      expect(() => parseTodoId(value)).toThrow(InvalidTodoIdError);
    }
    expect(() => formatTodoId("IC", 1)).toThrow(InvalidTodoIdError);
  });
});
