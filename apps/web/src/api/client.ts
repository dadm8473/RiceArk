type ApiErrorPayload = {
  error?: Record<string, unknown>;
};

export interface ApiRequestOptions {
  keepalive?: boolean;
  signal?: AbortSignal;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterMs: number | null = null,
    public readonly details: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, retryAt - Date.now());
}

async function buildApiError(response: Response, fallbackMessage: string): Promise<ApiClientError> {
  try {
    const payload = (await response.clone().json()) as ApiErrorPayload;
    const { code: rawCode, message: rawMessage, ...details } = payload.error ?? {};
    const code = typeof rawCode === "string" ? rawCode : "request_failed";
    const message = typeof rawMessage === "string" ? rawMessage : fallbackMessage;
    return new ApiClientError(
      response.status,
      code,
      message,
      parseRetryAfterMs(response.headers.get("Retry-After")),
      Object.keys(details).length > 0 ? details : null
    );
  } catch {
    return new ApiClientError(
      response.status,
      "request_failed",
      fallbackMessage,
      parseRetryAfterMs(response.headers.get("Retry-After"))
    );
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw await buildApiError(response, `GET ${path} failed`);
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await buildApiError(response, `POST ${path} failed`);
  return response.json() as Promise<T>;
}

export async function apiPostNoContent(path: string): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) throw await buildApiError(response, `POST ${path} failed`);
}

export async function apiPatch<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
    ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  if (!response.ok) throw await buildApiError(response, `PATCH ${path} failed`);
  return response.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<void> {
  const response = await fetch(path, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) throw await buildApiError(response, `DELETE ${path} failed`);
}
