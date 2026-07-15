import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { fetchExternal } from "../http/externalFetch";
import {
  normalizeCombatPower,
  normalizeItemLevel,
  normalizeLostArkCharacter,
  sortImportedCharacters,
  type ImportedCharacterCandidate,
  type LostArkArmoryCharacter
} from "./normalize";

const BASE_URL = "https://developer-lostark.game.onstove.com";

async function readJsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function lostArkHeaders(env: Env): Record<string, string> {
  if (!env.LOSTARK_API_KEY) {
    throw new ApiError(500, "lostark_key_missing", "Lost Ark API key is not configured");
  }
  return {
    accept: "application/json",
    authorization: `bearer ${env.LOSTARK_API_KEY}`
  };
}

function lostArkApiError(response: Response): ApiError {
  const retryAfter = response.status === 429 ? response.headers.get("Retry-After") : null;
  return new ApiError(
    response.status,
    "lostark_api_error",
    "Lost Ark API request failed",
    retryAfter ? { headers: { "Retry-After": retryAfter } } : {}
  );
}

function invalidLostArkProfile(): ApiError {
  return new ApiError(502, "lostark_profile_invalid", "Lost Ark profile response was invalid");
}

function requiredProfileText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw invalidLostArkProfile();
  return value.trim();
}

function normalizeLostArkProfile(value: unknown): ImportedCharacterCandidate | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidLostArkProfile();
  const profile = value as Partial<LostArkArmoryCharacter>;
  const itemLevel = normalizeItemLevel(profile.ItemAvgLevel);
  const numericItemLevel = Number(itemLevel.replaceAll(",", ""));
  if (!Number.isFinite(numericItemLevel) || numericItemLevel <= 0) throw invalidLostArkProfile();
  return {
    name: requiredProfileText(profile.CharacterName),
    serverName: requiredProfileText(profile.ServerName),
    className: requiredProfileText(profile.CharacterClassName),
    itemLevel,
    combatPower: normalizeCombatPower(profile.CombatPower)
  };
}

async function readLostArkProfile(response: Response): Promise<ImportedCharacterCandidate | null> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw invalidLostArkProfile();
  }
  return normalizeLostArkProfile(value);
}

export async function mapWithConcurrency<Item, Result>(
  items: Item[],
  concurrency: number,
  worker: (item: Item, index: number) => Promise<Result>
): Promise<Result[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }
  if (items.length === 0) return [];

  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let rejected = false;
  const runWorker = async () => {
    while (!rejected && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index] as Item, index);
      } catch (error) {
        if (!rejected) {
          rejected = true;
          firstError = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  if (rejected) throw firstError;
  return results;
}

export async function fetchLostArkCharacterProfile(
  env: Env,
  characterName: string
): Promise<ImportedCharacterCandidate | null> {
  const response = await fetchExternal(
    `${BASE_URL}/armories/characters/${encodeURIComponent(characterName)}/profiles`,
    { headers: lostArkHeaders(env) }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw lostArkApiError(response);
  return readLostArkProfile(response);
}

function normalizeCachedImportedCharacter(character: Partial<ImportedCharacterCandidate> | null | undefined): ImportedCharacterCandidate {
  return {
    name: String(character?.name ?? ""),
    serverName: String(character?.serverName ?? ""),
    className: String(character?.className ?? ""),
    itemLevel: normalizeItemLevel(character?.itemLevel),
    combatPower: normalizeCombatPower(character?.combatPower)
  };
}

async function fetchCombatPower(env: Env, characterName: string, options: { bypassCache?: boolean } = {}): Promise<string | null> {
  try {
    const cacheKey = `lostark:combat-power:v1:${characterName.toLowerCase()}`;
    const cached = options.bypassCache ? null : await env.CACHE.get(cacheKey, "json");
    if (cached && typeof cached === "object" && "combatPower" in cached) {
      return normalizeCombatPower((cached as { combatPower: unknown }).combatPower);
    }

    const response = await fetch(`${BASE_URL}/armories/characters/${encodeURIComponent(characterName)}/profiles`, {
      headers: {
        accept: "application/json",
        authorization: `bearer ${env.LOSTARK_API_KEY}`
      }
    });

    if (!response.ok) return null;

    const raw = (await readJsonOrNull(response)) as Pick<LostArkArmoryCharacter, "CombatPower"> | null;
    const combatPower = normalizeCombatPower(raw?.CombatPower);
    await env.CACHE.put(cacheKey, JSON.stringify({ combatPower }), { expirationTtl: 60 * 30 });
    return combatPower;
  } catch {
    return null;
  }
}

export async function searchRosterCharacters(
  env: Env,
  characterName: string,
  options: { bypassCache?: boolean } = {}
): Promise<ImportedCharacterCandidate[]> {
  lostArkHeaders(env);

  const cacheKey = `lostark:roster:v2:${characterName.toLowerCase()}`;
  const cached = options.bypassCache ? null : await env.CACHE.get(cacheKey, "json");
  if (Array.isArray(cached)) {
    return sortImportedCharacters(cached.map((character) => normalizeCachedImportedCharacter(character as Partial<ImportedCharacterCandidate>)));
  }

  const response = await fetch(`${BASE_URL}/characters/${encodeURIComponent(characterName)}/siblings`, {
    headers: {
      accept: "application/json",
      authorization: `bearer ${env.LOSTARK_API_KEY}`
    }
  });

  if (!response.ok) {
    throw new ApiError(response.status, "lostark_api_error", "Lost Ark API request failed");
  }

  const raw = await readJsonOrNull(response);
  if (!Array.isArray(raw)) {
    await env.CACHE.put(cacheKey, JSON.stringify([]), { expirationTtl: 60 * 30 });
    return [];
  }
  const normalized = raw.map(normalizeLostArkCharacter);
  const enriched = await mapWithConcurrency(
    normalized,
    4,
    async (character) => ({
      ...character,
      combatPower: character.combatPower ?? (await fetchCombatPower(env, character.name, options))
    })
  );
  const sorted = sortImportedCharacters(enriched);
  await env.CACHE.put(cacheKey, JSON.stringify(sorted), { expirationTtl: 60 * 30 });
  return sorted;
}
