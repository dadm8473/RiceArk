import { withBoundedInFlight } from "./boundedInFlight";

const publicJsonInFlight = new Map<string, Promise<Response>>();
type WorkerCacheStorage = CacheStorage & { default?: Cache };

function defaultCache(): Cache | null {
  return (globalThis.caches as WorkerCacheStorage | undefined)?.default ?? null;
}

function withPublicTtl(response: Response, ttlSeconds: number): Response {
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);

  return new Response(clone.body, {
    headers,
    status: clone.status,
    statusText: clone.statusText
  });
}

export function buildPublicCacheKey(requestUrl: string, namespace: string): Request {
  const source = new URL(requestUrl);
  const canonical = new URL(`/__riceark-cache/${namespace}`, source.origin);

  [...source.searchParams.entries()]
    .sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    )
    .forEach(([key, value]) => {
      canonical.searchParams.append(key, value);
    });

  return new Request(canonical.toString(), { method: "GET" });
}

export async function getPublicJson(
  requestUrl: string,
  namespace: string,
  ttlSeconds: number,
  loader: () => Promise<Response>
): Promise<Response> {
  const cacheKey = buildPublicCacheKey(requestUrl, namespace);
  const cache = defaultCache();

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return withPublicTtl(hit, ttlSeconds);
  }

  const shared = await withBoundedInFlight(publicJsonInFlight, cacheKey.url, async () => {
    const loaded = withPublicTtl(await loader(), ttlSeconds);
    if (cache && loaded.ok && loaded.status === 200) {
      await cache.put(cacheKey, loaded.clone());
    }
    return loaded;
  });

  return shared.clone();
}

export async function deletePublicCacheKey(
  requestUrl: string,
  namespace: string
): Promise<void> {
  const cache = defaultCache();
  if (!cache) return;

  await cache.delete(buildPublicCacheKey(requestUrl, namespace));
}
