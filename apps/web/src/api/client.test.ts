import { afterEach, describe, expect, it, vi } from "vitest";
import { apiDelete, apiGet, apiPatch, apiPostNoContent } from "./client";

describe("api client", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("passes keepalive and an abort signal to PATCH requests", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiPatch("/api/board/completions", { patches: [] }, { keepalive: true, signal: controller.signal })
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/board/completions",
      expect.objectContaining({ keepalive: true, signal: controller.signal })
    );
  });

  it("keeps the two-argument PATCH call compatible", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiPatch("/api/board/completions", { patches: [] })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/board/completions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ patches: [] })
    });
  });

  it("parses Retry-After seconds from API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Try again later" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "5" }
        });
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "Try again later",
      retryAfterMs: 5_000
    });
  });

  it("parses Retry-After HTTP dates from API errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "Wed, 15 Jul 2026 00:00:05 GMT" }
        });
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      retryAfterMs: 5_000
    });
  });

  it("clamps past Retry-After dates to zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "Tue, 14 Jul 2026 23:59:55 GMT" }
        });
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      retryAfterMs: 0
    });
  });

  it("uses null for malformed Retry-After headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "after lunch" }
        });
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      retryAfterMs: null
    });
  });

  it.each([
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["exponent", "1e3"],
    ["hexadecimal", "0x10"],
    ["infinite", "Infinity"],
    ["signed", "+5"],
    ["unsafe after conversion to milliseconds", "9007199254741"],
    ["overflowing after conversion to milliseconds", "1".padEnd(309, "0")]
  ])("rejects %s Retry-After delay-seconds", async (_description, retryAfter) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": retryAfter }
        });
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      retryAfterMs: null
    });
  });

  it.each([
    ["string", "not-an-error-object"],
    ["array", [{ code: "leaked_code", message: "Leaked message", rejectedKeys: ["cell-1"] }]],
    ["null", null]
  ])("uses fallback metadata for a %s error payload", async (_description, error) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      status: 400,
      code: "request_failed",
      message: "PATCH /api/board/completions failed",
      details: null
    });
  });

  it("preserves structured error details without changing their shape", async () => {
    const rejectedKeys = [
      { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", periodKey: "2026-07-15" }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_patches",
              message: "Some patches were rejected",
              rejectedKeys,
              context: { reason: "locked_table" }
            }
          }),
          { status: 422, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      status: 422,
      code: "invalid_patches",
      message: "Some patches were rejected",
      details: {
        rejectedKeys,
        context: { reason: "locked_table" }
      }
    });
  });
});
