import { withBoundedInFlight } from "../cache/boundedInFlight";
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
const ROSTER_CACHE_TTL_SECONDS = 60 * 30;
const rosterSearchInFlight = new Map<string, Promise<ImportedCharacterCandidate[]>>();

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

function normalizeCachedRoster(value: unknown): ImportedCharacterCandidate[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const characters = (value as { characters?: unknown }).characters;
  if (!Array.isArray(characters)) return null;
  return sortImportedCharacters(
    characters.map((character) =>
      normalizeCachedImportedCharacter(character as Partial<ImportedCharacterCandidate>)
    )
  );
}

async function fetchRosterCombatPower(
  headers: Record<string, string>,
  characterName: string
): Promise<string | null> {
  try {
    const response = await fetchExternal(
      `${BASE_URL}/armories/characters/${encodeURIComponent(characterName)}/profiles`,
      { headers }
    );
    if (!response.ok) return null;

    const raw = (await readJsonOrNull(response)) as Pick<LostArkArmoryCharacter, "CombatPower"> | null;
    return normalizeCombatPower(raw?.CombatPower);
  } catch {
    return null;
  }
}

export async function searchRosterCharacters(
  env: Env,
  characterName: string
): Promise<ImportedCharacterCandidate[]> {
  const headers = lostArkHeaders(env);
  const requestedName = characterName.trim();
  const cacheKey = `lostark:roster:v3:${requestedName.toLowerCase()}`;

  return withBoundedInFlight(rosterSearchInFlight, cacheKey, async () => {
    const cached = normalizeCachedRoster(await env.CACHE.get(cacheKey, "json"));
    if (cached) return cached;

    const response = await fetchExternal(
      `${BASE_URL}/characters/${encodeURIComponent(requestedName)}/siblings`,
      { headers }
    );
    if (!response.ok) throw lostArkApiError(response);

    const raw = await readJsonOrNull(response);
    const normalized = Array.isArray(raw)
      ? raw.map((character) => normalizeLostArkCharacter(character as LostArkArmoryCharacter))
      : [];
    const enriched = await mapWithConcurrency(
      normalized,
      4,
      async (character) => ({
        ...character,
        combatPower:
          character.combatPower ??
          (await fetchRosterCombatPower(headers, character.name))
      })
    );
    const sorted = sortImportedCharacters(enriched);
    await env.CACHE.put(
      cacheKey,
      JSON.stringify({ characters: sorted }),
      { expirationTtl: ROSTER_CACHE_TTL_SECONDS }
    );
    return sorted;
  });
}
