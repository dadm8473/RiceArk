import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "./client";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces structured API error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "Login required" }
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" }
          }
        );
      })
    );

    await expect(apiGet("/api/dashboard")).rejects.toThrow("Login required");
  });
});
