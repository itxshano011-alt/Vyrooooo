import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
} from "@/lib/api-errors";
import {
  likeLimiter,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * The video must be viewable by the caller (can_view_video via RLS);
 * the video_likes INSERT policy re-checks this at the database level.
 */
async function requireViewableVideo(
  videoId: string
): Promise<Awaited<ReturnType<typeof createClient>>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("videos")
    .select("id")
    .eq("id", videoId)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!data) throw notFound("Video not found");
  return supabase;
}

async function likeCount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  videoId: string
): Promise<number> {
  const { count, error } = await supabase
    .from("video_likes")
    .select("user_id", { count: "exact", head: true })
    .eq("video_id", videoId);
  if (error) throw fromPostgrestError(error);
  return count ?? 0;
}

/** Like a video. Idempotent: liking twice keeps liked=true. */
export const POST = handleRoute(async (_request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const { user } = await requireProfile();

  enforceRateLimit(likeLimiter, rateLimitKey(user.id, _request));

  const supabase = await requireViewableVideo(id);

  const { error } = await supabase
    .from("video_likes")
    .insert({ user_id: user.id, video_id: id });
  if (error && error.code !== "23505") {
    // 23505 (already liked) is swallowed for idempotency.
    throw fromPostgrestError(error, "Could not like video");
  }

  return NextResponse.json({
    liked: true,
    like_count: await likeCount(supabase, id),
  });
});

/** Unlike a video. Idempotent. */
export const DELETE = handleRoute(async (_request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const { user } = await requireProfile();

  enforceRateLimit(likeLimiter, rateLimitKey(user.id, _request));

  const supabase = await requireViewableVideo(id);

  const { error } = await supabase
    .from("video_likes")
    .delete()
    .eq("user_id", user.id)
    .eq("video_id", id);
  if (error) throw fromPostgrestError(error, "Could not unlike video");

  return NextResponse.json({
    liked: false,
    like_count: await likeCount(supabase, id),
  });
});
