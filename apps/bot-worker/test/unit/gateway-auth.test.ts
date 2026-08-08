import { describe, it, expect } from "vitest";
import { timingSafeTokenMatch } from "../../src/gateway-auth";

describe("timingSafeTokenMatch", () => {
  it("returns true when actual equals expected", () => {
    expect(timingSafeTokenMatch("secret-token", "secret-token")).toBe(true);
  });

  it("returns false when actual differs from expected", () => {
    expect(timingSafeTokenMatch("secret-token", "wrong-token")).toBe(false);
  });

  it("returns false when actual is null", () => {
    expect(timingSafeTokenMatch(null, "secret-token")).toBe(false);
  });

  it("returns false when expected is undefined", () => {
    expect(timingSafeTokenMatch("secret-token", undefined)).toBe(false);
  });

  it("returns false when expected is empty", () => {
    expect(timingSafeTokenMatch("secret-token", "")).toBe(false);
  });

  it("returns false when both are empty (no expected to match)", () => {
    expect(timingSafeTokenMatch("", "")).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(timingSafeTokenMatch("abc", "abcd")).toBe(false);
    expect(timingSafeTokenMatch("abcd", "abc")).toBe(false);
  });

  it("handles unicode tokens that share a UTF-16 prefix but differ in bytes", () => {
    // "a" and "å" share the first UTF-16 code unit but not the same byte length,
    // so the length check rejects before the byte loop.
    expect(timingSafeTokenMatch("å", "a")).toBe(false);
  });
});
