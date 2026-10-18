import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import { handleRoute, validationError } from "@/lib/api-errors";
import { usernameSchema } from "@/lib/validation";
import {
  authLimiter,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";

/**
 * Check whether a profile row with this username exists, using the admin
 * client so the answer is authoritative even for private profiles (which
 * RLS would hide from the caller's own client).
 *
 * Enumeration note: the response shape is identical whether the name is
 * taken or free ({ available: boolean }); there is deliberately no timing
 * obfuscation, just a rate limit (authLimiter, keyed by IP when anonymous)
 * to slow bulk probing.
 */
async function usernameTaken(username: string): Promise<boolean> {
  const { data, error } = await adminClient
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export const GET = handleRoute(async (request: NextRequest) => {
  const session = await getSessionUser();
  const viewerId = session?.user.id ?? null;

  // Rate limit before validation so malformed probes burn budget too.
  enforceRateLimit(
    authLimiter,
    rateLimitKey(viewerId, request)
  );

  const raw = new URL(request.url).searchParams.get("username") ?? "";
  const parsed = usernameSchema.safeParse(raw.toLowerCase());
  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  const taken = await usernameTaken(parsed.data);
  return NextResponse.json({ available: !taken });
});
