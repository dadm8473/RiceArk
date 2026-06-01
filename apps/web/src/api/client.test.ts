import { afterEach, describe, expect, it, vi } from "vitest";
import { apiDelete, apiGet, apiPostNoContent } from "./client";

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

  it("allows successful no-content POST responses", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiPostNoContent("/api/auth/logout")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      credentials: "include"
    });
  });

  it("sends DELETE requests with credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiDelete("/api/characters/character-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/characters/character-1", {
      method: "DELETE",
      credentials: "include"
    });
  });
});
