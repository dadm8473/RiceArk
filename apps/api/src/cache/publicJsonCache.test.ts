import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPublicCacheKey,
  deletePublicCacheKey,
  getPublicJson
} from "./publicJsonCache";

type CacheDouble = {
  delete: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  store: Map<string, Response>;
};

function createCacheDouble(): CacheDouble {
  const store = new Map<string, Response>();
  return {
    store,
    match: vi.fn(async (request: RequestInfo | URL) => {
      const key = request instanceof Request ? request.url : request.toString();
      return store.get(key) ?? null;
    }),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      const key = request instanceof Request ? request.url : request.toString();
      store.set(key, response);
    }),
    delete: vi.fn(async (request: RequestInfo | URL) => {
      const key = request instanceof Request ? request.url : request.toString();
      return store.delete(key);
    })
  };
}

describe("publicJsonCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds a canonical GET cache key with sorted duplicate query entries and no private headers", () => {
    const key = buildPublicCacheKey(
      "https://Example.COM:443/api/patch-notes?b=2&a=3&a=1&b=1",
      "patch-notes:v1"
    );

    expect(key.method).toBe("GET");
    expect(key.url).toBe(
      "https://example.com/__riceark-cache/patch-notes:v1?a=1&a=3&b=1&b=2"
    );
    expect(key.headers.get("cookie")).toBeNull();
    expect(key.headers.get("authorization")).toBeNull();
    expect([...key.headers.keys()]).toEqual([]);
  });

  it("returns a miss response with TTL, stores only 200 responses, and reuses the canonical hit", async () => {
    const cache = createCacheDouble();
    vi.stubGlobal("caches", { default: cache });
    const loader = vi.fn(async () => Response.json({ notes: ["first"] }));

    const first = await getPublicJson(
      "https://example.com/api/patch-notes?b=2&a=1",
      "patch-notes:v1",
      300,
      loader
    );
    const second = await getPublicJson(
      "https://example.com/another-path?a=1&b=2",
      "patch-notes:v1",
      300,
      loader
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=300");
    await expect(first.json()).resolves.toEqual({ notes: ["first"] });
    await expect(second.json()).resolves.toEqual({ notes: ["first"] });

    const stored = cache.store.get(
      "https://example.com/__riceark-cache/patch-notes:v1?a=1&b=2"
    );
    expect(stored?.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("returns a cloned cache hit so repeated callers can safely consume the body", async () => {
    const cache = createCacheDouble();
    const canonical = buildPublicCacheKey(
      "https://example.com/api/events?region=west",
      "events:v1"
    );
    cache.store.set(canonical.url, Response.json({ events: [1, 2, 3] }));
    vi.stubGlobal("caches", { default: cache });

    const first = await getPublicJson(
      "https://example.com/api/events?region=west",
      "events:v1",
      60,
      async () => {
        throw new Error("loader should not run on hit");
      }
    );
    const second = await getPublicJson(
      "https://example.com/api/events?region=west",
      "events:v1",
      60,
      async () => {
        throw new Error("loader should not run on hit");
      }
    );

    expect(first).not.toBe(second);
    await expect(first.json()).resolves.toEqual({ events: [1, 2, 3] });
    await expect(second.json()).resolves.toEqual({ events: [1, 2, 3] });
  });

  it("does not store a failed loader result", async () => {
    const cache = createCacheDouble();
    vi.stubGlobal("caches", { default: cache });
    const loader = vi.fn(async () => {
      throw new Error("upstream failed");
    });

    await expect(
      getPublicJson("https://example.com/api/fail?x=1", "fail:v1", 120, loader)
    ).rejects.toThrow("upstream failed");

    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(0);
  });

  it("does not store non-200 responses even when they are ok=false or ok=true", async () => {
    const cache = createCacheDouble();
    vi.stubGlobal("caches", { default: cache });
    const createdLoader = vi.fn(async () =>
      Response.json({ created: true }, { status: 201 })
    );
    const errorLoader = vi.fn(async () =>
      Response.json({ error: true }, { status: 500 })
    );

    const created = await getPublicJson(
      "https://example.com/api/create?x=1",
      "create:v1",
      45,
      createdLoader
    );
    const errored = await getPublicJson(
      "https://example.com/api/error?x=1",
      "error:v1",
      45,
      errorLoader
    );

    expect(created.status).toBe(201);
    expect(errored.status).toBe(500);
    expect(created.headers.get("Cache-Control")).toBe("public, max-age=45");
    expect(errored.headers.get("Cache-Control")).toBe("public, max-age=45");
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(0);
  });

  it("deduplicates concurrent misses and returns safe clones to each caller", async () => {
    const cache = createCacheDouble();
    vi.stubGlobal("caches", { default: cache });
    let resolve!: (response: Response) => void;
    const loader = vi.fn(
      () =>
        new Promise<Response>((innerResolve) => {
          resolve = innerResolve;
        })
    );

    const firstPromise = getPublicJson(
      "https://example.com/api/events?mode=all",
      "events:v1",
      60,
      loader
    );
    const secondPromise = getPublicJson(
      "https://example.com/api/events?mode=all",
      "events:v1",
      60,
      loader
    );

    await Promise.resolve();

    expect(loader).toHaveBeenCalledTimes(1);

    resolve(Response.json({ events: ["a"] }));

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).not.toBe(second);
    await expect(first.json()).resolves.toEqual({ events: ["a"] });
    await expect(second.json()).resolves.toEqual({ events: ["a"] });
  });

  it("works without the Cache API and makes cache deletion a no-op", async () => {
    const loader = vi.fn(async () => Response.json({ ok: true }));

    const response = await getPublicJson(
      "https://example.com/api/no-cache?x=1",
      "no-cache:v1",
      30,
      loader
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=30");
    await expect(response.json()).resolves.toEqual({ ok: true });
    await expect(
      deletePublicCacheKey("https://example.com/api/no-cache?x=1", "no-cache:v1")
    ).resolves.toBeUndefined();
  });

  it("deletes the canonical cache key when the Cache API is available", async () => {
    const cache = createCacheDouble();
    vi.stubGlobal("caches", { default: cache });

    await deletePublicCacheKey(
      "https://example.com/api/patch-notes?b=2&a=1",
      "patch-notes:v1"
    );

    expect(cache.delete).toHaveBeenCalledTimes(1);
    const deletedRequest = cache.delete.mock.calls[0]?.[0];
    expect(deletedRequest).toBeInstanceOf(Request);
    expect((deletedRequest as Request).url).toBe(
      "https://example.com/__riceark-cache/patch-notes:v1?a=1&b=2"
    );
  });
});
