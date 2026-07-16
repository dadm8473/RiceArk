import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHARACTER_SEARCH_CACHE_MAX_ENTRIES,
  CHARACTER_SEARCH_CACHE_TTL_MS,
  clearCharacterSearchCache,
  searchCharactersCached,
  type CharacterCandidate
} from "./characterSearchCache";

const candidate: CharacterCandidate = {
  name: "RiceArk",
  serverName: "아만",
  className: "바드",
  itemLevel: "1,640.00",
  combatPower: "12,345"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

describe("characterSearchCache", () => {
  afterEach(() => {
    clearCharacterSearchCache();
    vi.restoreAllMocks();
  });

  it("reuses normalized query hits for five minutes and returns defensive clones", async () => {
    const fetcher = vi.fn(async () => [candidate]);

    const first = await searchCharactersCached(" RiceArk ", fetcher, 1_000);
    first[0]!.name = "mutated";
    first.push({ ...candidate, name: "extra" });
    const second = await searchCharactersCached(
      "riceark",
      fetcher,
      1_000 + CHARACTER_SEARCH_CACHE_TTL_MS - 1
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("RiceArk");
    expect(second).toEqual([candidate]);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });

  it("reloads an entry at the five-minute expiry boundary", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce([{ ...candidate, combatPower: "1,000" }])
      .mockResolvedValueOnce([{ ...candidate, combatPower: "2,000" }]);

    await expect(searchCharactersCached("RiceArk", fetcher, 10)).resolves.toEqual([
      { ...candidate, combatPower: "1,000" }
    ]);
    await expect(
      searchCharactersCached("riceark", fetcher, 10 + CHARACTER_SEARCH_CACHE_TTL_MS)
    ).resolves.toEqual([{ ...candidate, combatPower: "2,000" }]);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch for duplicate normalized queries", async () => {
    const pending = deferred<CharacterCandidate[]>();
    const firstFetcher = vi.fn(() => pending.promise);
    const secondFetcher = vi.fn(async () => [{ ...candidate, name: "unexpected" }]);

    const first = searchCharactersCached(" RiceArk ", firstFetcher, 1_000);
    const second = searchCharactersCached("riceark", secondFetcher, 1_000);

    expect(firstFetcher).toHaveBeenCalledTimes(1);
    expect(secondFetcher).not.toHaveBeenCalled();

    pending.resolve([candidate]);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual([candidate]);
    expect(secondResult).toEqual([candidate]);
    expect(firstResult).not.toBe(secondResult);
    expect(firstResult[0]).not.toBe(secondResult[0]);
  });

  it("does not cache failures and clears rejected in-flight work", async () => {
    const failure = new Error("search failed");
    const fetcher = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([candidate]);

    await expect(searchCharactersCached("RiceArk", fetcher, 1_000)).rejects.toBe(failure);
    await expect(searchCharactersCached("riceark", fetcher, 1_001)).resolves.toEqual([candidate]);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps at most twenty settled entries and evicts the least recently used", async () => {
    expect(CHARACTER_SEARCH_CACHE_MAX_ENTRIES).toBe(20);
    const fetcher = vi.fn(async (name: string) => [{ ...candidate, name }]);

    for (let index = 0; index < CHARACTER_SEARCH_CACHE_MAX_ENTRIES; index += 1) {
      await searchCharactersCached(`name${index}`, fetcher, index);
    }
    await searchCharactersCached("name0", fetcher, 100);
    await searchCharactersCached("name20", fetcher, 101);
    await searchCharactersCached("name0", fetcher, 102);
    await searchCharactersCached("name1", fetcher, 103);

    expect(fetcher).toHaveBeenCalledTimes(22);
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe("name1");
  });
});
