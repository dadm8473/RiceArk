import type { Env } from "../env";
import { ApiError } from "../http/errors";
import {
  normalizeLostArkCharacter,
  type ImportedCharacterCandidate,
  type LostArkArmoryCharacter
} from "./normalize";

const BASE_URL = "https://developer-lostark.game.onstove.com";

export async function searchRosterCharacters(env: Env, characterName: string): Promise<ImportedCharacterCandidate[]> {
  if (!env.LOSTARK_API_KEY) {
    throw new ApiError(500, "lostark_key_missing", "Lost Ark API key is not configured");
  }

  const cacheKey = `lostark:roster:${characterName.toLowerCase()}`;
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
  await env.CACHE.put(cacheKey, JSON.stringify(normalized), { expirationTtl: 60 * 30 });
  return normalized;
}
