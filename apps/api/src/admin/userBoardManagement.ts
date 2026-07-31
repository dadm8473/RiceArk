import type { Env } from "../env";

const USER_PAGE_SIZE = 30;
const AUDIT_PAGE_SIZE = 50;

export type AdminAuditAction = string;

export interface AdminUserSummary {
  id: string;
  displayName: string;
  provider: "discord" | "google" | string;
  createdAt: string;
  recentActivityAt: string | null;
}

export interface AdminUserPage {
  users: AdminUserSummary[];
  nextCursor: string | null;
}

export interface AdminAuditLogPage {
  logs: Array<{
    id: string;
    adminUserId: string;
    adminDisplayName: string;
    targetUserId: string;
    targetDisplayName: string;
    method: string;
    action: string;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

type UserRow = {
  id: string;
  display_name: string;
  provider: string;
  created_at: string;
  recent_activity_at: string | null;
};

type AuditLogRow = {
  id: string;
  admin_user_id: string;
  admin_display_name: string;
  target_user_id: string;
  target_display_name: string;
  method: string;
  action: string;
  created_at: string;
};

type Cursor = [createdAt: string, id: string];
const SQLITE_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function normalizeAdminTimestamp(value: string): string {
  const explicitTimestamp = SQLITE_UTC_TIMESTAMP_PATTERN.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = new Date(explicitTimestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Invalid administrator timestamp");
  }
  return timestamp.toISOString();
}

function decodeCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as unknown;
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === "string" &&
      typeof decoded[1] === "string"
    ) {
      return [decoded[0], decoded[1]];
    }
  } catch {
    // The route layer treats malformed paging state as an invalid request.
  }
  throw new Error("Invalid administrator pagination cursor");
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function userSummary(row: UserRow): AdminUserSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    provider: row.provider,
    createdAt: normalizeAdminTimestamp(row.created_at),
    recentActivityAt: row.recent_activity_at
      ? normalizeAdminTimestamp(row.recent_activity_at)
      : null
  };
}

const USER_SUMMARY_COLUMNS = `
  users.id,
  users.display_name,
  COALESCE((
    SELECT oauth_accounts.provider
    FROM oauth_accounts
    WHERE oauth_accounts.user_id = users.id
    ORDER BY oauth_accounts.created_at DESC, oauth_accounts.id DESC
    LIMIT 1
  ), 'unknown') AS provider,
  users.created_at,
  NULLIF(MAX(
    COALESCE((
      SELECT MAX(sessions.created_at)
      FROM sessions
      WHERE sessions.user_id = users.id
    ), ''),
    COALESCE((
      SELECT MAX(completions.updated_at)
      FROM completions
      WHERE completions.user_id = users.id
    ), ''),
    COALESCE((
      SELECT MAX(board_cell_completions.updated_at)
      FROM board_cell_completions
      WHERE board_cell_completions.user_id = users.id
    ), ''),
    COALESCE((
      SELECT MAX(sheets.updated_at)
      FROM sheets
      WHERE sheets.user_id = users.id
    ), ''),
    COALESCE((
      SELECT MAX(characters.updated_at)
      FROM characters
      WHERE characters.user_id = users.id
    ), ''),
    COALESCE((
      SELECT MAX(tasks.updated_at)
      FROM tasks
      WHERE tasks.user_id = users.id
    ), '')
  ), '') AS recent_activity_at`;

export async function recordAdminAuditLog(
  env: Env,
  entry: {
    adminUserId: string;
    targetUserId: string;
    method: string;
    action: AdminAuditAction;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO admin_audit_logs (id, admin_user_id, target_user_id, method, action)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(crypto.randomUUID(), entry.adminUserId, entry.targetUserId, entry.method, entry.action)
    .run();
}

export async function listAdminUsers(
  env: Env,
  query: { search: string; cursor: string | null }
): Promise<AdminUserPage> {
  const cursor = decodeCursor(query.cursor);
  const result = await env.DB.prepare(
    `WITH page_users AS (
       SELECT users.id, users.display_name, users.created_at
       FROM users
       WHERE (
         ?1 = ''
         OR lower(users.display_name) LIKE '%' || lower(?1) || '%'
         OR lower(substr(users.id, -8)) LIKE '%' || lower(?1) || '%'
       )
       AND (
         ?2 IS NULL
         OR users.created_at < ?2
         OR (users.created_at = ?2 AND users.id < ?3)
       )
       ORDER BY users.created_at DESC, users.id DESC
       LIMIT 31
     )
     SELECT ${USER_SUMMARY_COLUMNS}
     FROM page_users AS users
     ORDER BY users.created_at DESC, users.id DESC`
  )
    .bind(query.search.trim(), cursor?.[0] ?? null, cursor?.[1] ?? null)
    .all<UserRow>();
  const rows = result.results ?? [];
  const pageRows = rows.slice(0, USER_PAGE_SIZE);
  const finalRow = pageRows.at(-1);

  return {
    users: pageRows.map(userSummary),
    nextCursor: rows.length > USER_PAGE_SIZE && finalRow ? encodeCursor([finalRow.created_at, finalRow.id]) : null
  };
}

export async function findAdminUserSummary(env: Env, userId: string): Promise<AdminUserSummary | null> {
  const row = await env.DB.prepare(
    `SELECT ${USER_SUMMARY_COLUMNS}
     FROM users
     WHERE users.id = ?1`
  )
    .bind(userId)
    .first<UserRow>();
  return row ? userSummary(row) : null;
}

export async function listAdminAuditLogs(env: Env, cursorValue: string | null = null): Promise<AdminAuditLogPage> {
  const cursor = decodeCursor(cursorValue);
  const result = await env.DB.prepare(
    `SELECT
       audit.id,
       audit.admin_user_id,
       admin.display_name AS admin_display_name,
       audit.target_user_id,
       target.display_name AS target_display_name,
       audit.method,
       audit.action,
       audit.created_at
     FROM admin_audit_logs AS audit
     JOIN users AS admin ON admin.id = audit.admin_user_id
     JOIN users AS target ON target.id = audit.target_user_id
     WHERE (
       ?1 IS NULL
       OR audit.created_at < ?1
       OR (audit.created_at = ?1 AND audit.id < ?2)
     )
     ORDER BY audit.created_at DESC, audit.id DESC
     LIMIT 51`
  )
    .bind(cursor?.[0] ?? null, cursor?.[1] ?? null)
    .all<AuditLogRow>();
  const rows = result.results ?? [];
  const pageRows = rows.slice(0, AUDIT_PAGE_SIZE);
  const finalRow = pageRows.at(-1);

  return {
    logs: pageRows.map((row) => ({
      id: row.id,
      adminUserId: row.admin_user_id,
      adminDisplayName: row.admin_display_name,
      targetUserId: row.target_user_id,
      targetDisplayName: row.target_display_name,
      method: row.method,
      action: row.action,
      createdAt: normalizeAdminTimestamp(row.created_at)
    })),
    nextCursor: rows.length > AUDIT_PAGE_SIZE && finalRow ? encodeCursor([finalRow.created_at, finalRow.id]) : null
  };
}
