import type { User } from "@supabase/supabase-js";
import { createClient } from "./supabase/server";
import { adminClient } from "./supabase/admin";
import { ApiError, unauthorized, forbidden } from "./api-errors";
import type { Profile } from "./db";

/**
 * Server-side auth helpers for Route Handlers.
 *
 * - requireUser(): authenticated Supabase user or throws 401.
 * - requireProfile(): { user, profile } or throws (401 when logged out, 500
 *   when the profile row is missing -- the handle_new_user trigger in
 *   migration 0002 creates it on signup, so a missing row is a data issue).
 * - getSessionUser(): optional auth; returns null when logged out instead of
 *   throwing, for public endpoints (feed, video detail, search).
 */

/** Typed auth failure; always maps to a 401 JSON response. */
export class AuthError extends ApiError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message);
    this.name = "AuthError";
  }
}

export interface SessionContext {
  user: User;
  profile: Profile;
}

/**
 * Load the caller's profile row with the per-request client so RLS applies.
 * Returns null when there is no session or no profile row.
 */
async function loadProfile(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as Profile;
}

export async function requireUser(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new AuthError();
  return user;
}

export async function requireProfile(): Promise<SessionContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new AuthError();

  const profile = await loadProfile(supabase, user.id);
  if (!profile) {
    throw new ApiError(
      500,
      "internal_error",
      "Your profile could not be loaded. Please sign out and sign in again."
    );
  }
  return { user, profile };
}

/**
 * Optional auth: returns the session context when a valid session exists,
 * otherwise null. Never throws for missing sessions.
 */
export async function getSessionUser(): Promise<SessionContext | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const profile = await loadProfile(supabase, user.id);
    if (!profile) return null;
    return { user, profile };
  } catch {
    return null;
  }
}

/** Re-export for handlers that only need the 401 helper. */
export { unauthorized };

/**
 * Admin gate for moderation endpoints. Verifies is_admin() (the private
 * admins table from migration 0001 -- admin rights never come from a
 * client-writable column) via the caller's own client, then hands back the
 * service-role client for the privileged work. Non-admins get 403.
 */
export async function requireAdmin(): Promise<{
  user: User;
  admin: typeof adminClient;
}> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_admin");
  if (error || data !== true) {
    throw forbidden("Admin access required");
  }
  return { user, admin: adminClient };
}
