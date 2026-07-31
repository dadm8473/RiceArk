import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPostNoContent,
  createApiClient,
  defaultApiClient
} from "./client";

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

  it("adds the admin target only to every request made by the scoped client", async () => {
    const fetchMock = vi.fn(async (_path: string, _request: RequestInit) =>
      new Response(JSON.stringify({ ok: true }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const scoped = createApiClient({ adminTargetUserId: "user-2" });

    await scoped.get("/api/board/bootstrap");
    await scoped.post("/api/board/tables", {});
    await scoped.postNoContent("/api/auth/logout");
    await scoped.patch("/api/board/completions", { patches: [] });
    await scoped.delete("/api/board/tables/table-1");

    for (const [, request] of fetchMock.mock.calls) {
      expect((request.headers as Headers).get("X-RiceArk-Admin-Target-User")).toBe("user-2");
    }

    await defaultApiClient.get("/api/board/bootstrap");
    const defaultRequest = fetchMock.mock.calls.at(-1)?.[1];
    expect((defaultRequest?.headers as Headers).get("X-RiceArk-Admin-Target-User")).toBeNull();
  });

  it("allows successful no-content POST responses", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiPostNoContent("/api/auth/logout")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.any(Headers)
      })
    );
  });

  it("sends DELETE requests with credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiDelete("/api/characters/character-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/characters/character-1",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
        headers: expect.any(Headers)
      })
    );
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
    const fetchMock = vi.fn(async (_path: string, _request: RequestInit) =>
      new Response(JSON.stringify({ ok: true }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiPatch("/api/board/completions", { patches: [] })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/board/completions",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.any(Headers),
        credentials: "include",
        body: JSON.stringify({ patches: [] })
      })
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect((request?.headers as Headers).get("Content-Type")).toBe("application/json");
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

  it.each([
    ["RFC850", "Wednesday, 15-Jul-26 00:00:05 GMT", "2026-07-15T00:00:00.000Z"],
    ["asctime", "Wed Jul 15 00:00:05 2026", "2026-07-15T00:00:00.000Z"],
    ["single-digit asctime", "Sun Jul  5 00:00:05 2026", "2026-07-05T00:00:00.000Z"]
  ])("parses %s Retry-After HTTP dates", async (_format, retryAfter, now) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
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
      retryAfterMs: 5_000
    });
  });

  it.each([
    ["a day", "Friday, 16-Jul-76 00:00:00 GMT"],
    ["a second", "Thursday, 15-Jul-76 00:00:01 GMT"]
  ])("rolls an RFC850 date %s beyond the 50-year cutoff into the past", async (_offset, retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
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
      retryAfterMs: 0
    });
  });

  it("validates the RFC850 weekday after resolving the two-digit year", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "Thursday, 16-Jul-76 00:00:00 GMT" }
        });
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      retryAfterMs: null
    });
  });

  it("keeps an RFC850 date exactly 50 years in the future", async () => {
    const now = Date.parse("2026-07-15T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "Wednesday, 15-Jul-76 00:00:00 GMT" }
        });
      })
    );

    await expect(apiPatch("/api/board/completions", { patches: [] })).rejects.toMatchObject({
      retryAfterMs: Date.parse("2076-07-15T00:00:00.000Z") - now
    });
  });

  it.each([
    ["IMF-fixdate", "Wed, 15 Jul 2026 00:00:60 GMT"],
    ["RFC850", "Wednesday, 15-Jul-26 00:00:60 GMT"],
    ["asctime", "Wed Jul 15 00:00:60 2026"]
  ])("parses %s Retry-After leap seconds", async (_format, retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
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
      retryAfterMs: 60_000
    });
  });

  it.each([
    ["invalid hour", "Wed, 15 Jul 2026 24:00:60 GMT"],
    ["invalid minute", "Wed, 15 Jul 2026 00:60:60 GMT"],
    ["invalid second", "Wed, 15 Jul 2026 00:00:61 GMT"],
    ["invalid calendar date", "Sun, 29 Feb 2026 23:59:60 GMT"],
    ["mismatched weekday", "Thu, 15 Jul 2026 00:00:60 GMT"]
  ])("rejects a leap second with an %s", async (_description, retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
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
    ["slash date", "1/2"],
    ["ISO date", "2026-07-16"],
    ["locale date", "July 16, 2026"],
    ["locale date with time", "Thu Jul 16 2026 00:00:00 GMT"],
    ["invalid calendar date", "Thu, 31 Feb 2026 00:00:00 GMT"],
    ["mismatched weekday", "Fri, 16 Jul 2026 00:00:00 GMT"],
    ["missing GMT", "Thu, 16 Jul 2026 00:00:00"],
    ["incorrect casing", "thu, 16 jul 2026 00:00:00 gmt"]
  ])("rejects a non-HTTP %s in Retry-After", async (_description, retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
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
