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

function normalizeLostArkProfile(value: unknown): ImportedCharacterCandidate {
  const profile = value && typeof value === "object"
    ? (value as Partial<LostArkArmoryCharacter>)
    : {};
  return {
    name: String(profile.CharacterName ?? ""),
    serverName: String(profile.ServerName ?? ""),
    className: String(profile.CharacterClassName ?? ""),
    itemLevel: normalizeItemLevel(profile.ItemAvgLevel),
    combatPower: normalizeCombatPower(profile.CombatPower)
  };
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
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as Item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
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
  return normalizeLostArkProfile(await readJsonOrNull(response));
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
