import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Typed API errors. Route handlers throw these (or return them via the
 * helpers below); the top-level catch converts them to safe JSON.
 *
 * Rule: error responses never leak stack traces, SQL, or private records.
 * The message is always a user-safe string; the code is a stable machine
 * identifier for clients.
 */

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "validation_failed"
  | "internal_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** Optional machine-readable field errors (from zod), safe to expose. */
  readonly details?: Record<string, string[]>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, string[]>
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = "Bad request") =>
  new ApiError(400, "bad_request", message);
export const unauthorized = (message = "Authentication required") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission") =>
  new ApiError(403, "forbidden", message);
export const notFound = (message = "Not found") =>
  new ApiError(404, "not_found", message);
export const conflict = (message = "Conflict") =>
  new ApiError(409, "conflict", message);
export const rateLimited = (retryAfterMs: number) =>
  new ApiError(429, "rate_limited", "Too many requests. Try again shortly.");

/** Build an ApiError from a zod parse failure (400, field-level details). */
export function validationError(error: ZodError): ApiError {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "body";
    const list = details[path] ?? [];
    list.push(issue.message);
    details[path] = list;
  }
  return new ApiError(400, "validation_failed", "Invalid request data", details);
}

/**
 * Map a Supabase/Postgres error to a safe ApiError. Only well-known,
 * user-meaningful codes are translated; everything else becomes a generic
 * 500 so internal details (constraint names, SQL) never reach the client.
 * The `context` message is always a hardcoded, caller-written string, so it
 * is safe to surface on unexpected failures too.
 */
export function fromPostgrestError(
  error: PostgrestError | { code?: string | null; message?: string | null },
  context?: string
): ApiError {
  switch (error.code) {
    case "23505": // unique_violation
      return conflict(context ?? "This already exists");
    case "23503": // foreign_key_violation
      return badRequest(context ?? "Referenced record does not exist");
    case "23514": // check_violation
      return badRequest(context ?? "Value violates a data constraint");
    case "42501": // insufficient_privilege (RLS denial)
      return forbidden(context ?? "You do not have permission");
    case "PGRST116": // no rows for .single()
      return notFound(context ?? "Not found");
    default:
      return new ApiError(500, "internal_error", context ?? "Something went wrong");
  }
}

interface ErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, string[]>;
  };
}

/** Convert any thrown value into a safe JSON error response. */
export function toErrorResponse(error: unknown): NextResponse<ErrorBody> {
  if (error instanceof ApiError) {
    const body: ErrorBody = {
      error: { code: error.code, message: error.message },
    };
    if (error.details) body.error.details = error.details;
    const headers =
      error.code === "rate_limited"
        ? { "Retry-After": "60" }
        : undefined;
    return NextResponse.json(body, { status: error.status, headers });
  }
  if (error instanceof ZodError) {
    return toErrorResponse(validationError(error));
  }
  // Unknown failure: log server-side is the caller's job; the client only
  // ever sees the generic message.
  return NextResponse.json(
    { error: { code: "internal_error", message: "Something went wrong" } },
    { status: 500 }
  );
}

/**
 * Wrap a route handler so every code path returns safe JSON: thrown
 * ApiErrors/ZodErrors/PostgrestErrors map to their status codes, and any
 * unexpected exception becomes a generic 500 without a stack trace.
 */
export function handleRoute<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await handler(...args);
    } catch (error) {
      // Postgrest errors surface as plain objects with a `code`, not as
      // ApiError; translate them here so handlers can simply rethrow.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        "message" in error &&
        !("status" in error)
      ) {
        return toErrorResponse(
          fromPostgrestError(error as PostgrestError)
        );
      }
      return toErrorResponse(error);
    }
  };
}
