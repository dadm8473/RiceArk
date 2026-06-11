import type { Env } from "../env";
import { ApiError } from "../http/errors";
import {
  normalizeCombatPower,
  normalizeItemLevel,
  normalizeLostArkCharacter,
  sortImportedCharacters,
  type ImportedCharacterCandidate,
  type LostArkArmoryCharacter
} from "./normalize";

const BASE_URL = "https://developer-lostark.game.onstove.com";

interface LostArkProfile {
  CombatPower?: string | number | null;
}

async function readJsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
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

    const raw = (await readJsonOrNull(response)) as LostArkProfile | null;
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
  if (!env.LOSTARK_API_KEY) {
    throw new ApiError(500, "lostark_key_missing", "Lost Ark API key is not configured");
  }

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
  const enriched = await Promise.all(
    normalized.map(async (character) => ({
      ...character,
      combatPower: character.combatPower ?? (await fetchCombatPower(env, character.name, options))
    }))
  );
  const sorted = sortImportedCharacters(enriched);
  await env.CACHE.put(cacheKey, JSON.stringify(sorted), { expirationTtl: 60 * 30 });
  return sorted;
}
