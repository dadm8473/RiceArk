import type { CharacterSelection } from "@riceark/core";
import { normalizeCharacterSelection } from "@riceark/core";
import type { Env } from "../env";
import { searchRosterCharacters } from "../lostark/client";
import {
  buildBoardMutationVersions,
  bumpBoardSheetVersionsForCharacterStatement,
  type BoardMutationResult,
  type BoardMutationVersions,
  type BoardSheetVersion
} from "./boardVersions";

export interface CharacterSnapshot {
  id?: string;
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

export interface CharacterRefreshRateLimited {
  type: "rate_limited";
  retryAfterSeconds: number;
}

export interface CharacterRefreshSuccess {
  character: CharacterSnapshot;
  versions: BoardMutationVersions;
}

export const CHARACTER_REFRESH_COOLDOWN_MS = 60_000;

function firstBatchRow<T>(result: unknown): T | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as T) : null;
}

function returnedMutationId(result: unknown, expectedId: string): string | null {
  const row = firstBatchRow<{ id?: unknown }>(result);
  return row?.id === expectedId ? expectedId : null;
}

function returnedSheetVersions(result: unknown): BoardSheetVersion[] | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return null;
  const versions = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { id, version } = row as { id?: unknown; version?: unknown };
    return typeof id === "string" && typeof version === "number" ? [{ id, version }] : [];
  });
  return versions.length === rows.length ? versions : null;
}

function buildCharacterMutationResult(
  mutationResult: unknown,
  versionResult: unknown,
  characterId: string
): BoardMutationResult | null {
  const mutationId = returnedMutationId(mutationResult, characterId);
  const sheetVersions = returnedSheetVersions(versionResult);
  if (sheetVersions === null) throw new Error("Character mutation batch returned malformed version rows");
  if (!mutationId) {
    if (sheetVersions.length > 0) throw new Error("Character mutation batch returned versions without a character mutation");
    return null;
  }
  return { ok: true, versions: buildBoardMutationVersions(sheetVersions) };
}

function parseStoredTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function saveSelectedCharacters(env: Env, userId: string, selected: CharacterSelection[]): Promise<void> {
  const characters = normalizeCharacterSelection(selected);
  const statements = characters.map((character, index) =>
    env.DB.prepare(
      `INSERT INTO characters (id, user_id, name, server_name, class_name, item_level, combat_power, sort_order, enabled, deleted_at, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 'lostark', CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, name, server_name)
       DO UPDATE SET class_name = excluded.class_name,
                     item_level = excluded.item_level,
                     combat_power = excluded.combat_power,
                     sort_order = excluded.sort_order,
                     source = 'lostark',
                     enabled = 1,
                     deleted_at = NULL,
                     updated_at = CURRENT_TIMESTAMP`
    ).bind(
      crypto.randomUUID(),
      userId,
      character.name,
      character.serverName,
      character.className,
      character.itemLevel,
      character.combatPower ?? null,
      index * 10
    )
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

export async function createManualCharacter(
  env: Env,
  userId: string,
  input: Omit<CharacterSnapshot, "id">
): Promise<{ id: string }> {
  const existing = await env.DB.prepare(
    `SELECT id
     FROM characters
     WHERE user_id = ? AND name = ? AND server_name = ? AND enabled = 1 AND deleted_at IS NULL`
  )
    .bind(userId, input.name, input.serverName)
    .first<{ id: string }>();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const maxSort = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), -10) AS max_sort FROM characters WHERE user_id = ?")
    .bind(userId)
    .first<{ max_sort: number }>();
  await env.DB.prepare(
    `INSERT INTO characters (
       id,
       user_id,
       name,
       server_name,
       class_name,
       item_level,
       combat_power,
       sort_order,
       enabled,
       deleted_at,
       source,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 'manual', CURRENT_TIMESTAMP)`
  )
    .bind(
      id,
      userId,
      input.name,
      input.serverName,
      input.className,
      input.itemLevel,
      input.combatPower,
      (maxSort?.max_sort ?? -10) + 10
    )
    .run();
  return { id };
}

export async function updateCharacterDisplayName(
  env: Env,
  userId: string,
  characterId: string,
  displayName: string | null
): Promise<BoardMutationResult | null> {
  const [updatedResult, versionResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE characters
       SET display_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL
       RETURNING id`
    ).bind(displayName, characterId, userId),
    bumpBoardSheetVersionsForCharacterStatement(env, userId, characterId)
  ]);
  return buildCharacterMutationResult(updatedResult, versionResult, characterId);
}

export async function updateCharacterDetails(
  env: Env,
  userId: string,
  characterId: string,
  input: {
    name?: string | undefined;
    serverName?: string | null | undefined;
    className?: string | null | undefined;
    displayName: string | null;
    itemLevel: string | null;
    combatPower: string | null;
    memo?: string | null | undefined;
  }
): Promise<BoardMutationResult | null> {
  const [updatedResult, versionResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE characters
       SET name = CASE WHEN source = 'manual' AND ? = 1 THEN ? ELSE name END,
           server_name = CASE WHEN source = 'manual' AND ? = 1 THEN ? ELSE server_name END,
           class_name = CASE WHEN source = 'manual' AND ? = 1 THEN ? ELSE class_name END,
           display_name = ?,
           item_level = ?,
           combat_power = ?,
           memo = CASE WHEN ? = 1 THEN ? ELSE memo END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL
       RETURNING id`
    ).bind(
      input.name !== undefined ? 1 : 0,
      input.name ?? null,
      input.serverName !== undefined ? 1 : 0,
      input.serverName ?? "",
      input.className !== undefined ? 1 : 0,
      input.className ?? "",
      input.displayName,
      input.itemLevel ?? "",
      input.combatPower,
      input.memo !== undefined ? 1 : 0,
      input.memo ?? null,
      characterId,
      userId
    ),
    bumpBoardSheetVersionsForCharacterStatement(env, userId, characterId)
  ]);
  return buildCharacterMutationResult(updatedResult, versionResult, characterId);
}

export async function updateCharacterFromLostArk(
  env: Env,
  userId: string,
  characterId: string
): Promise<CharacterRefreshSuccess | CharacterRefreshRateLimited | "manual" | "not_found" | "not_available"> {
  const current = await env.DB.prepare(
    `SELECT id, name, server_name, source, last_refresh_attempt_at
     FROM characters
     WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
  )
    .bind(characterId, userId)
    .first<{ id: string; name: string; server_name: string; source: string; last_refresh_attempt_at: string | null }>();
  if (!current) return "not_found";
  if (current.source === "manual") return "manual";

  const now = Date.now();
  const lastAttempt = parseStoredTimestamp(current.last_refresh_attempt_at);
  if (lastAttempt !== null) {
    const retryAfterMs = CHARACTER_REFRESH_COOLDOWN_MS - (now - lastAttempt);
    if (retryAfterMs > 0) {
      return {
        type: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000))
      };
    }
  }

  await env.DB.prepare(
    `UPDATE characters
     SET last_refresh_attempt_at = ?
     WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
  )
    .bind(new Date(now).toISOString(), characterId, userId)
    .run();

  const roster = await searchRosterCharacters(env, current.name, { bypassCache: true });
  const latest = roster.find((character) => character.name === current.name && character.serverName === current.server_name);
  if (!latest) return "not_available";

  const [updatedResult, versionResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE characters
       SET class_name = ?,
           item_level = ?,
           combat_power = ?,
           source = 'lostark',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL
       RETURNING id`
    ).bind(latest.className, latest.itemLevel, latest.combatPower, characterId, userId),
    bumpBoardSheetVersionsForCharacterStatement(env, userId, characterId)
  ]);
  const mutation = buildCharacterMutationResult(updatedResult, versionResult, characterId);
  if (!mutation) return "not_found";

  const character = {
    id: characterId,
    name: latest.name,
    serverName: latest.serverName,
    className: latest.className,
    itemLevel: latest.itemLevel,
    combatPower: latest.combatPower
  };
  return { character, versions: mutation.versions };
}

export async function deleteCharacter(
  env: Env,
  userId: string,
  characterId: string
): Promise<BoardMutationResult | null> {
  const [versionResult, deletedResult] = await env.DB.batch([
    bumpBoardSheetVersionsForCharacterStatement(env, userId, characterId),
    env.DB.prepare(
      `UPDATE characters
       SET enabled = 0,
           deleted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL
       RETURNING id`
    ).bind(characterId, userId)
  ]);
  return buildCharacterMutationResult(deletedResult, versionResult, characterId);
}

export async function reorderCharacters(env: Env, userId: string, characterIds: string[]): Promise<boolean> {
  if (characterIds.length === 0) return true;

  const placeholders = characterIds.map(() => "?").join(", ");
  const existing = await env.DB.prepare(
    `SELECT id FROM characters
     WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL AND id IN (${placeholders})`
  )
    .bind(userId, ...characterIds)
    .all<{ id: string }>();
  if (existing.results.length !== characterIds.length) return false;

  await env.DB.batch(
    characterIds.map((id, index) =>
      env.DB.prepare(
        `UPDATE characters
         SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
      ).bind(index * 10, id, userId)
    )
  );
  return true;
}
