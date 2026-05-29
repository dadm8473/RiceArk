type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function buildApiError(response: Response, fallbackMessage: string): Promise<ApiClientError> {
  try {
    const payload = (await response.clone().json()) as ApiErrorPayload;
    const code = payload.error?.code ?? "request_failed";
    const message = payload.error?.message ?? fallbackMessage;
    return new ApiClientError(response.status, code, message);
  } catch {
    return new ApiClientError(response.status, "request_failed", fallbackMessage);
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

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await buildApiError(response, `PATCH ${path} failed`);
  return response.json() as Promise<T>;
}
