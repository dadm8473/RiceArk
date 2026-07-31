import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { readSessionCookie } from "./cookies";
import { findUserBySessionToken, type AuthenticatedUser } from "./sessions";

export async function requireUser<E extends { Bindings: Env }>(c: Context<E>): Promise<AuthenticatedUser> {
  const token = readSessionCookie(c.req.header("cookie") ?? null);
  if (!token) throw new ApiError(401, "unauthorized", "Login required");
  const user = await findUserBySessionToken(c.env, token);
  if (!user) throw new ApiError(401, "unauthorized", "Login required");
  return user;
}
