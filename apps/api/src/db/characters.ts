import type { CharacterSelection } from "@riceark/core";
import { normalizeCharacterSelection } from "@riceark/core";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { fetchLostArkCharacterProfile, mapWithConcurrency } from "../lostark/client";
import type { ImportedCharacterCandidate } from "../lostark/normalize";
import {
  buildBoardMutationVersions,
  bumpBoardSheetVersionsForCharacterImportStatement,
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

export type CharacterRefreshBatchItem =
  | { id: string; status: "updated"; character: CharacterSnapshot }
  | { id: string; status: "manual" | "not_found" | "not_available" }
  | { id: string; status: "rate_limited"; retryAfterSeconds: number }
  | { id: string; status: "failed"; code: string };

export interface CharacterRefreshBatchResult {
  results: CharacterRefreshBatchItem[];
  versions: BoardMutationVersions;
}

export const CHARACTER_REFRESH_COOLDOWN_MS = 60_000;
export const CHARACTER_REFRESH_BATCH_MAX_COUNT = 40;
const CHARACTER_REFRESH_APPLY_MAX_ATTEMPTS = 2;
const CHARACTER_REFRESH_CONFLICT_CODE = "character_refresh_conflict";
const CHARACTER_REFRESH_GUARD_CONSTRAINT_PATH =
  "$[riceark_character_refresh_exact_set_guard_constraint_v1";
const CHARACTER_REFRESH_GUARD_CONSTRAINT_SIGNATURE =
  `bad JSON path: '${CHARACTER_REFRESH_GUARD_CONSTRAINT_PATH}'`;

interface CharacterRefreshRow {
  position: number;
  requested_id: string;
  id: string | null;
  name: string | null;
  server_name: string | null;
  class_name: string | null;
  item_level: string | null;
  combat_power: string | null;
  source: string | null;
  last_refresh_attempt_at: string | null;
}

interface CharacterRefreshRetryRow {
  position: number;
  requested_id: string;
  id: string | null;
}

interface CharacterRefreshClaimRow extends CharacterRefreshRetryRow {
  source: string | null;
  enabled: number | null;
  deleted_at: string | null;
  last_refresh_attempt_at: string | null;
}

interface CharacterRefreshEligibleCandidate {
  index: number;
  id: string;
  name: string;
  serverName: string;
}

interface CharacterRefreshProfileSuccess extends CharacterRefreshEligibleCandidate {
  profile: ImportedCharacterCandidate;
}

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

function returnedIds(result: unknown): string[] | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return null;
  const ids = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const id = (row as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
  return ids.length === rows.length ? ids : null;
}

function returnedUniqueIdSubset(result: unknown, expectedIds: Set<string>, errorMessage: string): Set<string> {
  const ids = returnedIds(result);
  if (
    ids === null ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !expectedIds.has(id))
  ) {
    throw new Error(errorMessage);
  }
  return new Set(ids);
}

function returnedExactIdSet(result: unknown, expectedIds: Set<string>, errorMessage: string): Set<string> {
  const ids = returnedIds(result);
  if (
    ids === null ||
    ids.length !== expectedIds.size ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !expectedIds.has(id))
  ) {
    throw new Error(errorMessage);
  }
  return new Set(ids);
}

function isCharacterRefreshGuardConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes(CHARACTER_REFRESH_GUARD_CONSTRAINT_SIGNATURE);
}

function completeCharacterRefreshResults(
  results: Array<CharacterRefreshBatchItem | undefined>
): CharacterRefreshBatchItem[] {
  if (results.some((result) => result === undefined)) {
    throw new Error("Character refresh did not produce every requested result");
  }
  return results as CharacterRefreshBatchItem[];
}

function retryAfterSecondsFrom(error: ApiError): number {
  const retryAfter = error.options.headers?.["Retry-After"];
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isSafeInteger(seconds)) return Math.max(1, seconds);
  }
  if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  }
  return CHARACTER_REFRESH_COOLDOWN_MS / 1000;
}

function characterRefreshFailureCode(error: unknown): string {
  return error instanceof ApiError ? error.code : "lostark_api_unavailable";
}

function characterIdentityKey(name: string, serverName: string): string {
  return JSON.stringify([name, serverName]);
}

function returnedCharacterIdentityKeys(result: unknown): string[] | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return null;
  const keys = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { name, server_name: serverName } = row as { name?: unknown; server_name?: unknown };
    return typeof name === "string" && typeof serverName === "string" ? [characterIdentityKey(name, serverName)] : [];
  });
  return keys.length === rows.length ? keys : null;
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

async function classifyUnclaimedCharacterRefreshes(
  env: Env,
  userId: string,
  candidates: CharacterRefreshEligibleCandidate[],
  now: number,
  results: Array<CharacterRefreshBatchItem | undefined>
): Promise<void> {
  const ids = candidates.map((candidate) => candidate.id);
  const loaded = await env.DB.prepare(
    `WITH input AS (
       SELECT CAST(key AS INTEGER) AS position,
              CASE WHEN typeof(value) = 'text' THEN value END AS id
       FROM json_each(?2)
     )
     SELECT input.position,
            input.id AS requested_id,
            characters.id,
            characters.source,
            characters.enabled,
            characters.deleted_at,
            characters.last_refresh_attempt_at
     FROM input
     LEFT JOIN characters
       ON characters.id = input.id
      AND characters.user_id = ?1
     ORDER BY input.position`
  ).bind(userId, JSON.stringify(ids)).all<CharacterRefreshClaimRow>();
  const rows = loaded.results ?? [];
  if (
    rows.length !== candidates.length ||
    rows.some((row, index) => row.position !== index || row.requested_id !== candidates[index]?.id)
  ) {
    throw new Error("Character refresh claim reload did not return every requested id in order");
  }

  for (const [index, candidate] of candidates.entries()) {
    const row = rows[index];
    if (!row?.id || row.enabled !== 1 || row.deleted_at !== null) {
      results[candidate.index] = { id: candidate.id, status: "not_found" };
      continue;
    }
    if (row.source === "manual") {
      results[candidate.index] = { id: candidate.id, status: "manual" };
      continue;
    }
    const lastAttempt = parseStoredTimestamp(row.last_refresh_attempt_at);
    const retryAfterMs = lastAttempt === null ? 0 : CHARACTER_REFRESH_COOLDOWN_MS - (now - lastAttempt);
    results[candidate.index] = retryAfterMs > 0
      ? {
          id: candidate.id,
          status: "rate_limited",
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000))
        }
      : { id: candidate.id, status: "failed", code: CHARACTER_REFRESH_CONFLICT_CODE };
  }
}

async function applyCharacterRefreshProfiles(
  env: Env,
  userId: string,
  successes: CharacterRefreshProfileSuccess[]
): Promise<BoardSheetVersion[]> {
  const profilesJson = JSON.stringify(successes.map(({ id, profile }) => ({
    id,
    className: profile.className,
    itemLevel: profile.itemLevel,
    combatPower: profile.combatPower
  })));
  const [versionResult, updatedResult, guardResult] = await env.DB.batch([
    env.DB.prepare(
      `WITH input AS (
         SELECT json_extract(value, '$.id') AS id,
                json_extract(value, '$.className') AS class_name,
                json_extract(value, '$.itemLevel') AS item_level,
                json_extract(value, '$.combatPower') AS combat_power
         FROM json_each(?2)
       ),
       valid_input AS (
         SELECT *
         FROM input
         WHERE typeof(id) = 'text'
           AND typeof(class_name) = 'text'
           AND typeof(item_level) = 'text'
           AND (combat_power IS NULL OR typeof(combat_power) = 'text')
       ),
       changed_characters AS (
         SELECT characters.id
         FROM characters
         JOIN valid_input ON valid_input.id = characters.id
         WHERE characters.user_id = ?1
           AND characters.enabled = 1
           AND characters.deleted_at IS NULL
           AND characters.source <> 'manual'
           AND (
             characters.class_name IS NOT valid_input.class_name
             OR characters.item_level IS NOT valid_input.item_level
             OR characters.combat_power IS NOT valid_input.combat_power
             OR characters.source <> 'lostark'
           )
       ),
       affected_sheets AS (
         SELECT DISTINCT board_tables.sheet_id
         FROM board_axis_items
         JOIN board_tables
           ON board_tables.id = board_axis_items.table_id
          AND board_tables.user_id = board_axis_items.user_id
         JOIN changed_characters
           ON changed_characters.id = board_axis_items.character_id
         WHERE board_axis_items.user_id = ?1
           AND board_tables.user_id = ?1
       )
       UPDATE sheets
       SET content_version = content_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE sheets.user_id = ?1
         AND json_array_length(?2) > 0
         AND (SELECT COUNT(*) FROM valid_input) = json_array_length(?2)
         AND (SELECT COUNT(DISTINCT id) FROM valid_input) = json_array_length(?2)
         AND sheets.id IN (SELECT sheet_id FROM affected_sheets)
       RETURNING id, content_version AS version`
    ).bind(userId, profilesJson),
    env.DB.prepare(
      `WITH input AS (
         SELECT json_extract(value, '$.id') AS id,
                json_extract(value, '$.className') AS class_name,
                json_extract(value, '$.itemLevel') AS item_level,
                json_extract(value, '$.combatPower') AS combat_power
         FROM json_each(?2)
       ),
       valid_input AS (
         SELECT *
         FROM input
         WHERE typeof(id) = 'text'
           AND typeof(class_name) = 'text'
           AND typeof(item_level) = 'text'
           AND (combat_power IS NULL OR typeof(combat_power) = 'text')
       )
       UPDATE characters
       SET class_name = (SELECT class_name FROM valid_input WHERE valid_input.id = characters.id),
           item_level = (SELECT item_level FROM valid_input WHERE valid_input.id = characters.id),
           combat_power = (SELECT combat_power FROM valid_input WHERE valid_input.id = characters.id),
           source = 'lostark',
           updated_at = CURRENT_TIMESTAMP
       WHERE characters.user_id = ?1
         AND characters.enabled = 1
         AND characters.deleted_at IS NULL
         AND characters.source <> 'manual'
         AND characters.id IN (SELECT id FROM valid_input)
         AND (SELECT COUNT(*) FROM valid_input) = json_array_length(?2)
         AND (SELECT COUNT(DISTINCT id) FROM valid_input) = json_array_length(?2)
       RETURNING id`
    ).bind(userId, profilesJson),
    env.DB.prepare(
      // The invalid JSON path is evaluated only on a count mismatch and gives this rollback guard a unique signature.
      `INSERT INTO characters (
         id, user_id, name, server_name, class_name, item_level, combat_power,
         sort_order, enabled, deleted_at, source, updated_at
       )
       SELECT '__riceark_character_refresh_exact_set_guard__',
              ?1,
              '__riceark_character_refresh_exact_set_guard__',
              '__riceark_character_refresh_exact_set_guard__',
              '__riceark_character_refresh_exact_set_guard__',
              '0',
              NULL,
              0,
              1,
              NULL,
              json_extract('[]', ?3),
              CURRENT_TIMESTAMP
       WHERE changes() <> json_array_length(?2)
          OR (SELECT COUNT(*) FROM json_each(?2)) <> json_array_length(?2)
          OR (
            SELECT COUNT(DISTINCT json_extract(value, '$.id'))
            FROM json_each(?2)
          ) <> json_array_length(?2)
       RETURNING id`
    ).bind(userId, profilesJson, CHARACTER_REFRESH_GUARD_CONSTRAINT_PATH)
  ]);

  const sheetVersions = returnedSheetVersions(versionResult);
  if (
    sheetVersions === null ||
    new Set(sheetVersions.map((sheet) => sheet.id)).size !== sheetVersions.length
  ) {
    throw new Error("Character refresh batch returned invalid sheet versions");
  }
  const expectedSuccessIds = new Set(successes.map((success) => success.id));
  returnedExactIdSet(
    updatedResult,
    expectedSuccessIds,
    "Character refresh batch returned invalid character ids"
  );
  const guardIds = returnedIds(guardResult);
  if (guardIds === null || guardIds.length !== 0) {
    throw new Error("Character refresh batch returned an invalid exact-set guard result");
  }
  return sheetVersions;
}

async function reloadEligibleCharacterRefreshProfiles(
  env: Env,
  userId: string,
  successes: CharacterRefreshProfileSuccess[],
  results: Array<CharacterRefreshBatchItem | undefined>
): Promise<CharacterRefreshProfileSuccess[]> {
  const ids = successes.map((success) => success.id);
  const loaded = await env.DB.prepare(
    `WITH input AS (
       SELECT CAST(key AS INTEGER) AS position,
              CASE WHEN typeof(value) = 'text' THEN value END AS id
       FROM json_each(?2)
     )
     SELECT input.position,
            input.id AS requested_id,
            characters.id
     FROM input
     LEFT JOIN characters
       ON characters.id = input.id
      AND characters.user_id = ?1
      AND characters.enabled = 1
      AND characters.deleted_at IS NULL
      AND characters.source <> 'manual'
     ORDER BY input.position`
  ).bind(userId, JSON.stringify(ids)).all<CharacterRefreshRetryRow>();
  const rows = loaded.results ?? [];
  if (
    rows.length !== successes.length ||
    rows.some((row, index) => row.position !== index || row.requested_id !== successes[index]?.id)
  ) {
    throw new Error("Character refresh retry load did not return every requested id in order");
  }
  return successes.filter((success, index) => {
    if (rows[index]?.id === success.id) return true;
    results[success.index] = { id: success.id, status: "not_found" };
    return false;
  });
}

export async function saveSelectedCharacters(env: Env, userId: string, selected: CharacterSelection[]): Promise<void> {
  const characters = normalizeCharacterSelection(selected);
  if (characters.length === 0) return;

  const rows = characters.map((character, index) => ({
    id: crypto.randomUUID(),
    name: character.name,
    serverName: character.serverName,
    className: character.className,
    itemLevel: character.itemLevel,
    combatPower: character.combatPower ?? null,
    sortOrder: index * 10
  }));
  const rowsJson = JSON.stringify(rows);
  const [versionResult, upsertResult] = await env.DB.batch([
    bumpBoardSheetVersionsForCharacterImportStatement(env, userId, rows),
    env.DB.prepare(
      `WITH input AS (
         SELECT CAST(key AS INTEGER) AS position,
                json_extract(value, '$.id') AS id,
                json_extract(value, '$.name') AS name,
                json_extract(value, '$.serverName') AS server_name,
                json_extract(value, '$.className') AS class_name,
                json_extract(value, '$.itemLevel') AS item_level,
                json_extract(value, '$.combatPower') AS combat_power,
                json_extract(value, '$.sortOrder') AS sort_order
         FROM json_each(?2)
       ),
       valid_input AS (
         SELECT *
         FROM input
         WHERE typeof(id) = 'text'
           AND typeof(name) = 'text'
           AND typeof(server_name) = 'text'
           AND typeof(class_name) = 'text'
           AND typeof(item_level) = 'text'
           AND (combat_power IS NULL OR typeof(combat_power) = 'text')
           AND typeof(sort_order) = 'integer'
       )
       INSERT INTO characters (
         id, user_id, name, server_name, class_name, item_level, combat_power,
         sort_order, enabled, deleted_at, source, updated_at
       )
       SELECT id, ?1, name, server_name, class_name, item_level, combat_power,
              sort_order, 1, NULL, 'lostark', CURRENT_TIMESTAMP
       FROM valid_input
       WHERE (SELECT COUNT(*) FROM valid_input) = json_array_length(?2)
         AND (
           SELECT COUNT(*)
           FROM (SELECT name, server_name FROM valid_input GROUP BY name, server_name)
         ) = json_array_length(?2)
       ON CONFLICT(user_id, name, server_name)
       DO UPDATE SET class_name = excluded.class_name,
                     item_level = excluded.item_level,
                     combat_power = excluded.combat_power,
                     sort_order = excluded.sort_order,
                     source = 'lostark',
                     enabled = 1,
                     deleted_at = NULL,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING id, name, server_name`
    ).bind(userId, rowsJson)
  ]);

  const versions = returnedSheetVersions(versionResult);
  if (!versions || new Set(versions.map((version) => version.id)).size !== versions.length) {
    throw new Error("Character import batch returned malformed version rows");
  }
  const returnedKeys = returnedCharacterIdentityKeys(upsertResult);
  const expectedKeys = new Set(rows.map((row) => characterIdentityKey(row.name, row.serverName)));
  if (
    !returnedKeys ||
    returnedKeys.length !== expectedKeys.size ||
    new Set(returnedKeys).size !== returnedKeys.length ||
    returnedKeys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("Character import batch did not return every character");
  }
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

export async function refreshCharactersFromLostArk(
  env: Env,
  userId: string,
  characterIds: string[]
): Promise<CharacterRefreshBatchResult> {
  if (characterIds.length === 0) return { results: [], versions: { sheets: [] } };
  if (!env.LOSTARK_API_KEY) {
    throw new ApiError(500, "lostark_key_missing", "Lost Ark API key is not configured");
  }
  if (characterIds.length > CHARACTER_REFRESH_BATCH_MAX_COUNT) {
    throw new RangeError(`Character refresh accepts at most ${CHARACTER_REFRESH_BATCH_MAX_COUNT} ids`);
  }
  if (new Set(characterIds).size !== characterIds.length) {
    throw new Error("Character refresh ids must be unique");
  }

  const requestedIdsJson = JSON.stringify(characterIds);
  const loaded = await env.DB.prepare(
    `WITH input AS (
       SELECT CAST(key AS INTEGER) AS position,
              CASE WHEN typeof(value) = 'text' THEN value END AS id
       FROM json_each(?2)
     )
     SELECT input.position,
            input.id AS requested_id,
            characters.id,
            characters.name,
            characters.server_name,
            characters.class_name,
            characters.item_level,
            characters.combat_power,
            characters.source,
            characters.last_refresh_attempt_at
     FROM input
     LEFT JOIN characters
       ON characters.id = input.id
      AND characters.user_id = ?1
      AND characters.enabled = 1
      AND characters.deleted_at IS NULL
     ORDER BY input.position`
  ).bind(userId, requestedIdsJson).all<CharacterRefreshRow>();
  const rows = loaded.results ?? [];
  if (
    rows.length !== characterIds.length ||
    rows.some((row, index) => row.position !== index || row.requested_id !== characterIds[index])
  ) {
    throw new Error("Character refresh load did not return every requested id in order");
  }

  const now = Date.now();
  const results: Array<CharacterRefreshBatchItem | undefined> = new Array(characterIds.length);
  const eligible: CharacterRefreshEligibleCandidate[] = [];
  for (const row of rows) {
    if (!row.id || !row.name || !row.server_name) {
      results[row.position] = { id: row.requested_id, status: "not_found" };
      continue;
    }
    if (row.source === "manual") {
      results[row.position] = { id: row.id, status: "manual" };
      continue;
    }
    const lastAttempt = parseStoredTimestamp(row.last_refresh_attempt_at);
    const retryAfterMs = lastAttempt === null ? 0 : CHARACTER_REFRESH_COOLDOWN_MS - (now - lastAttempt);
    if (retryAfterMs > 0) {
      results[row.position] = {
        id: row.id,
        status: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000))
      };
      continue;
    }
    eligible.push({ index: row.position, id: row.id, name: row.name, serverName: row.server_name });
  }

  if (eligible.length === 0) {
    return { results: completeCharacterRefreshResults(results), versions: { sheets: [] } };
  }

  const eligibleIds = eligible.map((candidate) => candidate.id);
  const expectedEligibleIds = new Set(eligibleIds);
  const attemptAt = new Date(now).toISOString();
  const cutoffAt = new Date(now - CHARACTER_REFRESH_COOLDOWN_MS).toISOString();
  const stamped = await env.DB.prepare(
    `WITH input AS (
       SELECT value AS id
       FROM json_each(?2)
       WHERE typeof(value) = 'text'
     )
     UPDATE characters
     SET last_refresh_attempt_at = ?3
     WHERE user_id = ?1
       AND enabled = 1
       AND deleted_at IS NULL
       AND source <> 'manual'
       AND id IN (SELECT id FROM input)
       AND (
         last_refresh_attempt_at IS NULL
         OR julianday(last_refresh_attempt_at) IS NULL
         OR julianday(last_refresh_attempt_at) <= julianday(?4)
       )
       AND (SELECT COUNT(DISTINCT id) FROM input) = json_array_length(?2)
     RETURNING id`
  ).bind(userId, JSON.stringify(eligibleIds), attemptAt, cutoffAt).all<{ id: string }>();
  const stampedIds = returnedUniqueIdSubset(
    stamped,
    expectedEligibleIds,
    "Character refresh attempt stamp returned invalid character ids"
  );
  const attempted = eligible.filter((candidate) => stampedIds.has(candidate.id));
  const unclaimed = eligible.filter((candidate) => !stampedIds.has(candidate.id));
  if (unclaimed.length > 0) {
    await classifyUnclaimedCharacterRefreshes(env, userId, unclaimed, now, results);
  }

  const profileOutcomes = await mapWithConcurrency(attempted, 4, async (candidate) => {
    try {
      const profile = await fetchLostArkCharacterProfile(env, candidate.name);
      if (!profile) return { ...candidate, result: { id: candidate.id, status: "not_available" } as const };
      if (profile.name !== candidate.name || profile.serverName !== candidate.serverName) {
        return {
          ...candidate,
          result: {
            id: candidate.id,
            status: "failed",
            code: "lostark_profile_identity_mismatch"
          } as const
        };
      }
      return { ...candidate, profile };
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        return {
          ...candidate,
          result: {
            id: candidate.id,
            status: "rate_limited",
            retryAfterSeconds: retryAfterSecondsFrom(error)
          } as const
        };
      }
      return {
        ...candidate,
        result: { id: candidate.id, status: "failed", code: characterRefreshFailureCode(error) } as const
      };
    }
  });

  const successes: CharacterRefreshProfileSuccess[] = [];
  for (const outcome of profileOutcomes) {
    if ("profile" in outcome) successes.push(outcome);
    else results[outcome.index] = outcome.result;
  }
  if (successes.length === 0) {
    return { results: completeCharacterRefreshResults(results), versions: { sheets: [] } };
  }

  let pendingSuccesses = successes;
  let appliedSuccesses: CharacterRefreshProfileSuccess[] = [];
  let sheetVersions: BoardSheetVersion[] = [];
  for (let attempt = 0; attempt < CHARACTER_REFRESH_APPLY_MAX_ATTEMPTS && pendingSuccesses.length > 0; attempt += 1) {
    try {
      sheetVersions = await applyCharacterRefreshProfiles(env, userId, pendingSuccesses);
      appliedSuccesses = pendingSuccesses;
      break;
    } catch (error) {
      if (!isCharacterRefreshGuardConstraint(error)) throw error;
      if (attempt + 1 >= CHARACTER_REFRESH_APPLY_MAX_ATTEMPTS) {
        for (const success of pendingSuccesses) {
          results[success.index] = {
            id: success.id,
            status: "failed",
            code: CHARACTER_REFRESH_CONFLICT_CODE
          };
        }
        pendingSuccesses = [];
        break;
      }
      pendingSuccesses = await reloadEligibleCharacterRefreshProfiles(env, userId, pendingSuccesses, results);
    }
  }
  for (const success of appliedSuccesses) {
    results[success.index] = {
      id: success.id,
      status: "updated",
      character: {
        id: success.id,
        name: success.name,
        serverName: success.serverName,
        className: success.profile.className,
        itemLevel: success.profile.itemLevel,
        combatPower: success.profile.combatPower
      }
    };
  }

  return {
    results: completeCharacterRefreshResults(results),
    versions: buildBoardMutationVersions(sheetVersions)
  };
}

export async function updateCharacterFromLostArk(
  env: Env,
  userId: string,
  characterId: string
): Promise<CharacterRefreshSuccess | CharacterRefreshRateLimited | "manual" | "not_found" | "not_available"> {
  const refreshed = await refreshCharactersFromLostArk(env, userId, [characterId]);
  const result = refreshed.results[0];
  if (!result) return "not_found";
  if (result.status === "updated") return { character: result.character, versions: refreshed.versions };
  if (result.status === "rate_limited") {
    return { type: "rate_limited", retryAfterSeconds: result.retryAfterSeconds };
  }
  if (result.status === "failed") {
    throw new ApiError(502, result.code, "Lost Ark character refresh failed");
  }
  return result.status;
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

  const idsJson = JSON.stringify(characterIds);
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `WITH input AS (
         SELECT CAST(key AS INTEGER) AS position, value AS id
         FROM json_each(?2)
       ),
       valid AS (
         SELECT input.position, input.id
         FROM input
         JOIN characters ON characters.id = input.id
         WHERE characters.user_id = ?1
           AND characters.enabled = 1
           AND characters.deleted_at IS NULL
       )
       UPDATE characters
       SET sort_order = (
             SELECT valid.position * 10
             FROM valid
             WHERE valid.id = characters.id
           ),
           updated_at = CURRENT_TIMESTAMP
       WHERE characters.user_id = ?1
         AND characters.enabled = 1
         AND characters.deleted_at IS NULL
         AND characters.id IN (SELECT id FROM valid)
         AND (SELECT COUNT(*) FROM valid) = json_array_length(?2)
         AND (SELECT COUNT(DISTINCT id) FROM input) = json_array_length(?2)
       RETURNING id`
    ).bind(userId, idsJson)
  ]);
  const returned = returnedIds(result);
  if (returned === null) throw new Error("Character order returned malformed rows");
  if (returned.length === 0) return false;
  const expected = new Set(characterIds);
  if (
    returned.length !== expected.size ||
    new Set(returned).size !== returned.length ||
    returned.some((id) => !expected.has(id))
  ) {
    throw new Error("Character order did not return every character");
  }
  return true;
}
