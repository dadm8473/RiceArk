import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function jsonError(c: Context, error: ApiError): Response {
  return c.json({ error: { code: error.code, message: error.message } }, error.status as ContentfulStatusCode);
}

export function notFound(): ApiError {
  return new ApiError(404, "not_found", "Route not found");
}
