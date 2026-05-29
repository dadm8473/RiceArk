import type { Env } from "../env";

const encoder = new TextEncoder();

export interface AuthenticatedUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export async function hashSessionToken(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function createSession(env: Env, userId: string, token: string, now = new Date()): Promise<void> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET);
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, tokenHash, expires)
    .run();
}

export async function findUserBySessionToken(env: Env, token: string): Promise<AuthenticatedUser | null> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET);
  const row = await env.DB.prepare(
    `SELECT users.id, users.display_name, users.avatar_url
     FROM sessions
     INNER JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP
     LIMIT 1`
  )
    .bind(tokenHash)
    .first<{ id: string; display_name: string; avatar_url: string | null }>();

  return row ? { id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url } : null;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}
