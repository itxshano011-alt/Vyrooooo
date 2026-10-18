import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  badRequest,
  forbidden,
  validationError,
} from "@/lib/api-errors";
import { followSchema } from "@/lib/validation";
import {
  followLimiter,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";
import { getProfileCounts } from "@/lib/profile-reads";

/**
 * Follow a user. Idempotent: following someone twice still returns success.
 * Self-follows are rejected (the DB CHECK would also reject them), and
 * follows across a block in either direction are rejected by RLS.
 */
export const POST = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  const parsed = followSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);
  const { user_id: targetId } = parsed.data;

  if (targetId === user.id) {
    throw badRequest("You cannot follow yourself");
  }

  enforceRateLimit(followLimiter, rateLimitKey(user.id, request));

  // Target must exist and not be block-involved with the caller.
  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id")
    .eq("id", targetId)
    .maybeSingle();
  if (targetError) throw fromPostgrestError(targetError);
  if (!target) throw notFound("User not found");

  const supabase = await createClient();
  const { data: blocked } = await supabase.rpc("blocked_between", {
    a: user.id,
    b: targetId,
  });
  if (blocked === true) {
    throw forbidden("You cannot follow this user");
  }

  const { error } = await supabase
    .from("follows")
    .insert({ follower_id: user.id, followed_id: targetId });
  if (error && error.code !== "23505") {
    // 23505 (already following) is swallowed for idempotency; the RLS
    // WITH CHECK re-validates the block rule on every insert.
    throw fromPostgrestError(error, "Could not follow user");
  }

  const [targetCounts, myCounts] = await Promise.all([
    getProfileCounts(targetId),
    getProfileCounts(user.id),
  ]);
  return NextResponse.json({
    following: true,
    follower_count: targetCounts.follower_count,
    following_count: myCounts.following_count,
  });
});

/**
 * Unfollow a user (?user_id=). Idempotent: unfollowing someone you do not
 * follow still returns success.
 */
export const DELETE = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  const parsed = followSchema.safeParse({
    user_id: new URL(request.url).searchParams.get("user_id"),
  });
  if (!parsed.success) throw validationError(parsed.error);
  const { user_id: targetId } = parsed.data;

  enforceRateLimit(followLimiter, rateLimitKey(user.id, request));

  const supabase = await createClient();
  const { error } = await supabase
    .from("follows")
    .delete()
    .eq("follower_id", user.id)
    .eq("followed_id", targetId);
  if (error) throw fromPostgrestError(error, "Could not unfollow user");

  const [targetCounts, myCounts] = await Promise.all([
    getProfileCounts(targetId),
    getProfileCounts(user.id),
  ]);
  return NextResponse.json({
    following: false,
    follower_count: targetCounts.follower_count,
    following_count: myCounts.following_count,
  });
});
