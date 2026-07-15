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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IMF_FIXDATE_PATTERN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) GMT$/;
const RFC850_DATE_PATTERN =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) GMT$/;
const ASCTIME_DATE_PATTERN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ((?:[0-9]{2}| [0-9])) ([0-9]{2}:[0-9]{2}:[0-9]{2}) ([0-9]{4})$/;

const RFC850_WEEKDAYS: Record<string, string> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun"
};

function capture(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function parseCanonicalHttpDate(weekday: string, day: string, month: string, year: string, time: string): number | null {
  const canonicalDate = `${weekday}, ${day} ${month} ${year} ${time} GMT`;
  const timestamp = Date.parse(canonicalDate);
  if (Number.isNaN(timestamp) || new Date(timestamp).toUTCString() !== canonicalDate) return null;
  return timestamp;
}

function expandRfc850Year(year: string): string {
  const currentYear = new Date(Date.now()).getUTCFullYear();
  let expandedYear = Math.floor(currentYear / 100) * 100 + Number(year);

  if (expandedYear - currentYear > 50) expandedYear -= 100;
  return String(expandedYear).padStart(4, "0");
}

function parseHttpDate(value: string): number | null {
  const imfFixdate = IMF_FIXDATE_PATTERN.exec(value);
  if (imfFixdate) {
    return parseCanonicalHttpDate(
      capture(imfFixdate, 1),
      capture(imfFixdate, 2),
      capture(imfFixdate, 3),
      capture(imfFixdate, 4),
      capture(imfFixdate, 5)
    );
  }

  const rfc850Date = RFC850_DATE_PATTERN.exec(value);
  if (rfc850Date) {
    const weekday = RFC850_WEEKDAYS[capture(rfc850Date, 1)];
    if (weekday === undefined) return null;

    return parseCanonicalHttpDate(
      weekday,
      capture(rfc850Date, 2),
      capture(rfc850Date, 3),
      expandRfc850Year(capture(rfc850Date, 4)),
      capture(rfc850Date, 5)
    );
  }

  const asctimeDate = ASCTIME_DATE_PATTERN.exec(value);
  if (asctimeDate) {
    return parseCanonicalHttpDate(
      capture(asctimeDate, 1),
      capture(asctimeDate, 3).trim().padStart(2, "0"),
      capture(asctimeDate, 2),
      capture(asctimeDate, 5),
      capture(asctimeDate, 4)
    );
  }

  return null;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null || value === "") return null;

  if (/^\d+$/.test(value)) {
    const retryAfterMs = Number(value) * 1_000;
    return Number.isSafeInteger(retryAfterMs) ? retryAfterMs : null;
  }

  const retryAt = parseHttpDate(value);
  if (retryAt === null) return null;
  return Math.max(0, retryAt - Date.now());
}

async function buildApiError(response: Response, fallbackMessage: string): Promise<ApiClientError> {
  try {
    const payload = (await response.clone().json()) as unknown;
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    const { code: rawCode, message: rawMessage, ...details } = error;
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
