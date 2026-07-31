import type { Context } from "hono";
import { type AdminAuditAction } from "../admin/userBoardManagement";
import type { AppEnv, Env } from "../env";
import { ApiError } from "../http/errors";
import { isAdminUser } from "./admin";
import { requireUser } from "./requireUser";
import type { AuthenticatedUser } from "./sessions";

export const ADMIN_TARGET_USER_HEADER = "X-RiceArk-Admin-Target-User";

export type UserAccess = {
  actor: AuthenticatedUser;
  subject: AuthenticatedUser;
  targeted: boolean;
};

export type AppContext = Context<AppEnv>;

async function findUserById(env: Env, userId: string): Promise<AuthenticatedUser | null> {
  const row = await env.DB.prepare(
    "SELECT id, display_name, avatar_url FROM users WHERE id = ? LIMIT 1"
  )
    .bind(userId)
    .first<{ id: string; display_name: string; avatar_url: string | null }>();
  return row ? { id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url } : null;
}

export async function requireUserAccess(
  c: AppContext,
  options: { allowAdminTarget: boolean }
): Promise<UserAccess> {
  const actor = await requireUser(c);
  const targetUserId = c.req.header(ADMIN_TARGET_USER_HEADER);
  if (!targetUserId) {
    const access = { actor, subject: actor, targeted: false };
    c.set("adminTargetAccess", access);
    return access;
  }
  if (!options.allowAdminTarget) {
    throw new ApiError(403, "admin_target_not_allowed", "Administrator target is not allowed for this route");
  }
  if (!(await isAdminUser(c.env, actor.id))) {
    throw new ApiError(403, "forbidden", "Admin access required");
  }

  const subject = await findUserById(c.env, targetUserId);
  if (!subject) throw new ApiError(404, "user_not_found", "User not found");

  const access = { actor, subject, targeted: true };
  c.set("adminTargetAccess", access);
  return access;
}

export async function requireSubjectUser(
  c: AppContext,
  options: { allowAdminTarget: boolean }
): Promise<AuthenticatedUser> {
  return (await requireUserAccess(c, options)).subject;
}

const boardMutations: Record<string, RegExp[]> = {
  POST: [
    /^\/api\/board\/(?:sheets|tables|notes|axis-items)$/,
    /^\/api\/board\/tables\/[^/]+\/(?:characters(?:\/(?:import|manual))?|tasks|transpose)$/
  ],
  PATCH: [
    /^\/api\/board\/sheets\/[^/]+$/,
    /^\/api\/board\/notes\/[^/]+(?:\/layout)?$/,
    /^\/api\/board\/tables\/[^/]+(?:\/layout)?$/,
    /^\/api\/board\/axis-items\/(?:order|[^/]+(?:\/size)?)$/
  ],
  DELETE: [
    /^\/api\/board\/(?:sheets|notes|tables|axis-items)\/[^/]+$/
  ]
};

function matchesMutation(patterns: RegExp[] | undefined, path: string): boolean {
  return patterns?.some((pattern) => pattern.test(path)) ?? false;
}

export function getAdminAuditAction(method: string, path: string): AdminAuditAction | null {
  const normalizedMethod = method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) return null;

  if (normalizedMethod === "PATCH" && path === "/api/board/completions") {
    return "board.completions.update";
  }
  if (normalizedMethod === "PATCH" && path === "/api/board/cell-states") {
    return "board.cell_states.update";
  }
  if (matchesMutation(boardMutations[normalizedMethod], path)) return "board.update";

  if (
    (normalizedMethod === "POST" && /^\/api\/characters\/(?:refresh-batch|[^/]+\/refresh)$/.test(path))
  ) {
    return "characters.refresh";
  }
  if (
    (normalizedMethod === "PATCH" && /^\/api\/characters\/(?:order|[^/]+(?:\/display-name)?)$/.test(path)) ||
    (normalizedMethod === "POST" && /^\/api\/characters\/(?:manual|import)$/.test(path)) ||
    (normalizedMethod === "DELETE" && /^\/api\/characters\/[^/]+$/.test(path))
  ) {
    return "characters.update";
  }
  if (
    (normalizedMethod === "PATCH" && /^\/api\/tasks\/(?:order|[^/]+)$/.test(path)) ||
    (normalizedMethod === "POST" && path === "/api/tasks") ||
    (normalizedMethod === "DELETE" && /^\/api\/tasks\/[^/]+$/.test(path))
  ) {
    return "tasks.update";
  }
  if (normalizedMethod === "PATCH" && path === "/api/settings") return "settings.update";

  return null;
}
