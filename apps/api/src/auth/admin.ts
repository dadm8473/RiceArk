import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { requireUser } from "./requireUser";
import type { AuthenticatedUser } from "./sessions";

type OAuthAccountRow = {
  provider: string;
  provider_user_id: string;
};

function getAdminKeys(allowlist: string | undefined): Set<string> {
  return new Set(
    (allowlist ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function getOAuthAdminKey(row: OAuthAccountRow): string {
  return `${row.provider}:${row.provider_user_id}`;
}

export async function isAdminUser(env: Env, userId: string): Promise<boolean> {
  const adminKeys = getAdminKeys(env.ADMIN_OAUTH_ALLOWLIST);
  if (adminKeys.size === 0) return false;

  const { results } = await env.DB.prepare("SELECT provider, provider_user_id FROM oauth_accounts WHERE user_id = ?")
    .bind(userId)
    .all<OAuthAccountRow>();

  return results.some((row) => adminKeys.has(getOAuthAdminKey(row)));
}

export async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<AuthenticatedUser> {
  const user = await requireUser(c);
  if (!(await isAdminUser(c.env, user.id))) {
    throw new ApiError(403, "forbidden", "Admin access required");
  }
  return user;
}
