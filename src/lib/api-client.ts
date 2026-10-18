/**
 * Typed fetch wrapper for VYRO API routes.
 *
 * Every API route returns either the documented success body or
 * { error: { code, message, details? } }. This helper throws ApiClientError
 * (carrying status + code + field errors) on non-2xx responses so UI code
 * can render the server's message directly.
 */

/** Mirror of the API's error body, from src/lib/api-errors.ts. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string[]>;

  constructor(status: number, code: string, message: string, details?: Record<string, string[]>) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** true when the caller must sign in first (redirect to /login?next=...). */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ApiErrorBody).error === "object"
  );
}

interface RequestOptions extends RequestInit {
  /** Payload sent as JSON with Content-Type: application/json. */
  json?: unknown;
}

/** GET/POST/PUT/PATCH/DELETE against an API route, JSON in and out. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { json, headers, ...init } = options;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : init.body,
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const data: unknown = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    if (isErrorBody(data)) {
      throw new ApiClientError(res.status, data.error.code, data.error.message, data.error.details);
    }
    throw new ApiClientError(res.status, "unknown", `Request failed (${res.status})`);
  }
  return data as T;
}

/** Extract the first field error message for display, if any. */
export function firstFieldError(error: unknown): string | null {
  if (error instanceof ApiClientError && error.details) {
    const first = Object.values(error.details).flat()[0];
    return first ?? null;
  }
  return null;
}

/** User-safe message for any thrown value. */
export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof ApiClientError) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}
