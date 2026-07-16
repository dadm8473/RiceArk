import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import { createOAuthState } from "../auth/oauth";

const env = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  DISCORD_CLIENT_ID: "discord-client",
  DISCORD_CLIENT_SECRET: "discord-secret",
  SESSION_SECRET: "test-secret"
};

function createCallbackDb() {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => (sql.includes("SELECT user_id") ? null : null),
            run: async () => ({ success: true })
          };
        }
      };
    },
    batch: async () => []
  };
}

describe("auth routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to Google OAuth", async () => {
    const res = await app.request("/api/auth/google/start", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")?.split(/,\s*/)).toContain("Cookie");
  });

  it("rejects unknown providers", async () => {
    const res = await app.request("/api/auth/unknown/start", {}, env);
    expect(res.status).toBe(404);
  });

  it("redirects supported but unconfigured providers back to the app with a login error", async () => {
    const res = await app.request(
      "/api/auth/discord/start",
      {},
      {
        ...env,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined
      }
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:5173/?authError=oauth_unavailable&provider=discord");
  });

  it("accepts a signed Discord OAuth callback state without the temporary state cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("/oauth2/token")) {
          return Response.json({ access_token: "discord-access-token" });
        }
        if (href.includes("/users/@me")) {
          return Response.json({
            id: "discord-user",
            username: "rice",
            global_name: "쌀먹",
            email: "user@example.com",
            avatar: null
          });
        }
        return new Response(null, { status: 404 });
      })
    );
    const state = await createOAuthState("discord", env.SESSION_SECRET);
    const res = await app.request(
      `/api/auth/discord/callback?code=mobile-code&state=${encodeURIComponent(state)}`,
      {},
      { ...env, DB: createCallbackDb() }
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:5173");
  });

  it("keeps authenticated session responses private and uncached", async () => {
    const sessionDb = {
      prepare(sql: string) {
        return {
          bind: () => ({
            first: async () =>
              sql.includes("FROM sessions")
                ? { id: "user-1", display_name: "쌀먹도사", avatar_url: null }
                : null,
            all: async () => ({ results: [] })
          })
        };
      }
    };

    const res = await app.request(
      "/api/session",
      { headers: { cookie: "riceark_session=test-session" } },
      { ...env, DB: sessionDb }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")?.split(/,\s*/)).toContain("Cookie");
  });

  it("updates the profile display name for the logged-in user", async () => {
    const updates: Array<{ sql: string; binds: unknown[] }> = [];
    const profileDb = {
      prepare(sql: string) {
        const statement = {
          bind: (...binds: unknown[]) => ({
            first: async () => {
              if (sql.includes("FROM sessions")) {
                return { id: "user-1", display_name: "쌀먹도사", avatar_url: null };
              }
              return null;
            },
            run: async () => {
              updates.push({ sql, binds });
              return { success: true };
            },
            all: async () => ({ results: [] })
          })
        };
        return statement;
      }
    };

    const res = await app.request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { cookie: "riceark_session=test-session", "content-type": "application/json" },
        body: JSON.stringify({ displayName: "  열두글자닉네임테스트12  " })
      },
      { ...env, DB: profileDb }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")?.split(/,\s*/)).toContain("Cookie");
    await expect(res.json()).resolves.toMatchObject({
      user: { id: "user-1", displayName: "열두글자닉네임테스트12" }
    });
    const update = updates.find((entry) => entry.sql.includes("UPDATE users SET display_name"));
    expect(update?.binds).toEqual(["열두글자닉네임테스트12", "user-1"]);
  });

  it("rejects display names longer than 12 characters and anonymous profile updates", async () => {
    const sessionDb = {
      prepare(sql: string) {
        return {
          bind: () => ({
            first: async () => (sql.includes("FROM sessions") ? { id: "user-1", display_name: "쌀먹도사", avatar_url: null } : null),
            run: async () => ({ success: true }),
            all: async () => ({ results: [] })
          })
        };
      }
    };

    const tooLong = await app.request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { cookie: "riceark_session=test-session", "content-type": "application/json" },
        body: JSON.stringify({ displayName: "열세글자가넘어가는닉네임은안돼" })
      },
      { ...env, DB: sessionDb }
    );
    expect(tooLong.status).toBe(400);

    const anonymous = await app.request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "닉네임" })
      },
      { ...env, DB: sessionDb }
    );
    expect(anonymous.status).toBe(401);
  });
});
