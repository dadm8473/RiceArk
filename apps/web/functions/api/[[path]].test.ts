import { describe, expect, it } from "vitest";
import type { Env } from "@riceark/api/src/env";
import { onRequest } from "./[[path]]";

function testEnv(): Env {
  return {
    APP_ORIGIN: "https://riceark.pages.dev",
    COOKIE_DOMAIN: "riceark.pages.dev",
    ENVIRONMENT: "production",
    DB: {} as D1Database,
    CACHE: {} as KVNamespace
  };
}

describe("Pages API function", () => {
  it("forwards /api requests to the Hono API app", async () => {
    const response = await onRequest({
      request: new Request("https://riceark.pages.dev/api/health"),
      env: testEnv(),
      params: { path: ["health"] },
      waitUntil() {},
      passThroughOnException() {},
      next: async () => new Response("not found", { status: 404 }),
      data: {},
      functionPath: "api/[[path]]"
    } as unknown as EventContext<Env, "api/[[path]]", { path: string[] }>);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "riceark-api" });
  });
});
