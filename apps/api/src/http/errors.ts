import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ApiErrorOptions {
  details?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly options: ApiErrorOptions = {}
  ) {
    super(message);
  }
}

export function jsonError(c: Context, error: ApiError): Response {
  for (const [name, value] of Object.entries(error.options.headers ?? {})) c.header(name, value);
  const details = Object.fromEntries(
    Object.entries(error.options.details ?? {}).filter(([key]) => key !== "code" && key !== "message")
  );
  return c.json(
    { error: { ...details, code: error.code, message: error.message } },
    error.status as ContentfulStatusCode
  );
}

export function notFound(): ApiError {
  return new ApiError(404, "not_found", "Route not found");
}
