import { describe, expect, it } from "vitest";
import { buildSessionCookie, clearSessionCookie } from "./cookies";
import { hashSessionToken } from "./sessions";

describe("session helpers", () => {
  it("builds secure HttpOnly cookies", () => {
    const cookie = buildSessionCookie("abc", "riceark.example", 3600);
    expect(cookie).toContain("riceark_session=abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("clears session cookies", () => {
    expect(clearSessionCookie("riceark.example")).toContain("Max-Age=0");
  });

  it("hashes session tokens deterministically", async () => {
    await expect(hashSessionToken("token", "secret")).resolves.toBe(await hashSessionToken("token", "secret"));
  });
});
