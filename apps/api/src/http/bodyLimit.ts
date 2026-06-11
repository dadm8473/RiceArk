import type { Context, Next } from "hono";
import { ApiError } from "./errors";

export const MAX_API_BODY_BYTES = 64 * 1024;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function requestBodyTooLarge(request: Request, maxBytes: number): Promise<boolean> {
  if (!BODY_METHODS.has(request.method)) return false;

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed)) return parsed > maxBytes;
  }

  if (!request.body) return false;

  const reader = request.clone().body?.getReader();
  if (!reader) return false;

  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function bodyLimit(maxBytes = MAX_API_BODY_BYTES) {
  return async (c: Context, next: Next) => {
    if (await requestBodyTooLarge(c.req.raw, maxBytes)) {
      throw new ApiError(413, "payload_too_large", "Request body is too large");
    }
    await next();
  };
}
