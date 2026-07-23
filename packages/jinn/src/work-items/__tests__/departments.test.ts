import { describe, it, expect } from "vitest";
import { derivePrefixCandidate, pickFreePrefix } from "../departments.js";

describe("derivePrefixCandidate", () => {
  it("uses the standard company derivation when the slug supports it", () => {
    expect(derivePrefixCandidate("platform")).toBe("PLA");
    expect(derivePrefixCandidate("customer-success-team")).toBe("CST");
  });
  it("pads short slugs with X instead of throwing", () => {
    expect(derivePrefixCandidate("hr")).toBe("HRX");
    expect(derivePrefixCandidate("q")).toBe("QXX");
  });
  it("falls back to XXX when the slug has no letters", () => {
    expect(derivePrefixCandidate("123")).toBe("XXX");
  });
});

describe("pickFreePrefix", () => {
  it("returns the candidate when free", () => {
    expect(pickFreePrefix("PLA", new Set(["ACM"]))).toBe("PLA");
  });
  it("advances the third letter deterministically on collision", () => {
    expect(pickFreePrefix("PLA", new Set(["PLA"]))).toBe("PLB");
    expect(pickFreePrefix("PLA", new Set(["PLA", "PLB"]))).toBe("PLC");
  });
  it("wraps position 3 through A and moves to position 2 when exhausted", () => {
    const taken = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => `PL${c}`));
    expect(pickFreePrefix("PLA", taken)).toBe("PAA");
  });
});
