import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ApiError, jsonError } from "./errors";

describe("ApiError details", () => {
  it("serializes safe detail fields without allowing code or message overrides", async () => {
    const app = new Hono();
    app.get("/", () => {
      throw new ApiError(400, "authoritative_code", "Authoritative message", {
        details: {
          code: "spoofed_code",
          message: "Spoofed message",
          rejectedKeys: [{ tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1" }]
        },
        headers: { "Retry-After": "3" }
      });
    });
    app.onError((error, c) => jsonError(c, error as ApiError));

    const response = await app.request("/");

    expect(response.status).toBe(400);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toEqual({
      error: {
        code: "authoritative_code",
        message: "Authoritative message",
        rejectedKeys: [{ tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1" }]
      }
    });
  });

  it("preserves the existing payload when options are omitted", async () => {
    const app = new Hono();
    app.get("/", () => {
      throw new ApiError(404, "missing", "Missing");
    });
    app.onError((error, c) => jsonError(c, error as ApiError));

    expect(await (await app.request("/")).json()).toEqual({ error: { code: "missing", message: "Missing" } });
  });
});
