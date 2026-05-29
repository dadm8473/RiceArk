import type { Env } from "../env";
import { ApiError } from "../http/errors";
import {
  normalizeCombatPower,
  normalizeLostArkCharacter,
  sortImportedCharacters,
  type ImportedCharacterCandidate,
  type LostArkArmoryCharacter
} from "./normalize";

const BASE_URL = "https://developer-lostark.game.onstove.com";

interface LostArkProfile {
  CombatPower?: string | number | null;
}

async function fetchCombatPower(env: Env, characterName: string): Promise<string | null> {
  const cacheKey = `lostark:combat-power:v1:${characterName.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey, "json");
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

  const raw = (await response.json()) as LostArkProfile;
  const combatPower = normalizeCombatPower(raw.CombatPower);
  await env.CACHE.put(cacheKey, JSON.stringify({ combatPower }), { expirationTtl: 60 * 30 });
  return combatPower;
}

export async function searchRosterCharacters(env: Env, characterName: string): Promise<ImportedCharacterCandidate[]> {
  if (!env.LOSTARK_API_KEY) {
    throw new ApiError(500, "lostark_key_missing", "Lost Ark API key is not configured");
  }

  const cacheKey = `lostark:roster:v2:${characterName.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (Array.isArray(cached)) {
    return cached as ImportedCharacterCandidate[];
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

  const raw = (await response.json()) as LostArkArmoryCharacter[];
  const normalized = raw.map(normalizeLostArkCharacter);
  const enriched = await Promise.all(
    normalized.map(async (character) => ({
      ...character,
      combatPower: character.combatPower ?? (await fetchCombatPower(env, character.name))
    }))
  );
  const sorted = sortImportedCharacters(enriched);
  await env.CACHE.put(cacheKey, JSON.stringify(sorted), { expirationTtl: 60 * 30 });
  return sorted;
}
