export const CHARACTER_SEARCH_CACHE_TTL_MS = 5 * 60_000;
export const CHARACTER_SEARCH_CACHE_MAX_ENTRIES = 20;

export interface CharacterCandidate {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

export interface CharacterSearchCacheEntry {
  expiresAt: number;
  characters: CharacterCandidate[];
}

type CharacterSearchFetcher = (name: string) => Promise<CharacterCandidate[]>;

const settled = new Map<string, CharacterSearchCacheEntry>();
const inFlight = new Map<string, Promise<CharacterCandidate[]>>();
let cacheGeneration = 0;

function cloneCharacters(characters: CharacterCandidate[]): CharacterCandidate[] {
  return characters.map((character) => ({ ...character }));
}

function normalizeSearchKey(name: string): string {
  return name.trim().toLowerCase();
}

function retainSettled(key: string, entry: CharacterSearchCacheEntry) {
  settled.delete(key);
  settled.set(key, entry);

  while (settled.size > CHARACTER_SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = settled.keys().next().value;
    if (oldestKey === undefined) break;
    settled.delete(oldestKey);
  }
}

export function clearCharacterSearchCache(): void {
  cacheGeneration += 1;
  settled.clear();
  inFlight.clear();
}

export function searchCharactersCached(
  name: string,
  fetcher: CharacterSearchFetcher,
  now = Date.now()
): Promise<CharacterCandidate[]> {
  const requestedName = name.trim();
  const key = normalizeSearchKey(requestedName);
  const cached = settled.get(key);
  if (cached && cached.expiresAt > now) {
    retainSettled(key, cached);
    return Promise.resolve(cloneCharacters(cached.characters));
  }
  if (cached) settled.delete(key);

  const existing = inFlight.get(key);
  if (existing) return existing.then(cloneCharacters);

  const generation = cacheGeneration;
  let fetched: Promise<CharacterCandidate[]>;
  try {
    fetched = fetcher(requestedName);
  } catch (error) {
    fetched = Promise.reject(error);
  }
  const load = fetched.then((characters) => {
    const stored = cloneCharacters(characters);
    if (cacheGeneration === generation) {
      retainSettled(key, {
        characters: stored,
        expiresAt: now + CHARACTER_SEARCH_CACHE_TTL_MS
      });
    }
    return stored;
  });
  let tracked: Promise<CharacterCandidate[]>;
  tracked = load.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
  inFlight.set(key, tracked);
  return tracked.then(cloneCharacters);
}
