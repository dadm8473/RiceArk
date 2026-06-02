import { describe, expect, it } from "vitest";
import { normalizeBoundedIntegerDraft } from "./numberInput";

describe("normalizeBoundedIntegerDraft", () => {
  it("keeps blank drafts usable by falling back only when saving", () => {
    expect(normalizeBoundedIntegerDraft("", { min: 16, max: 1024, fallback: 132 })).toBe(132);
    expect(normalizeBoundedIntegerDraft("   ", { min: 16, max: 1024, fallback: 40 })).toBe(40);
  });

  it("clamps final numeric drafts to safe integer bounds", () => {
    expect(normalizeBoundedIntegerDraft("8", { min: 16, max: 1024, fallback: 40 })).toBe(16);
    expect(normalizeBoundedIntegerDraft("9999", { min: 16, max: 1024, fallback: 40 })).toBe(1024);
    expect(normalizeBoundedIntegerDraft("44.7", { min: 16, max: 1024, fallback: 40 })).toBe(45);
  });

  it("falls back when the final draft is not numeric", () => {
    expect(normalizeBoundedIntegerDraft("abc", { min: 16, max: 1024, fallback: 40 })).toBe(40);
  });
});
