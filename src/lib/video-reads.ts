/**
 * Shared video visibility logic for the /api/videos/[id] routes.
 *
 * This lives outside the route modules because Next.js rejects non-route
 * exports (anything besides GET/POST/.../revalidate/dynamic/...) from files
 * under src/app/api/**. Used by GET /api/videos/[id] (detail) and GET
 * /api/videos/[id]/stream (playback), so both enforce the exact same rule.
 */

import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { fromPostgrestError, notFound } from "@/lib/api-errors";
import {
  enrichVideos,
  fetchVisibleProfiles,
  type ReadContext,
  type Video,
} from "@/lib/db";

/**
 * Load a video through RLS (can_view_video) and enforce the API-level
 * creator-visibility rule: a video whose creator profile is not visible to
 * the viewer (private profile, not a follower) is treated as not found, so
 * feed cards and detail pages always link to a real, viewable profile.
 */
export async function getViewableVideo(
  videoId: string,
  viewerId: string | null
): Promise<{ video: Video; supabase: Awaited<ReturnType<typeof createClient>> }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .eq("id", videoId)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!data) throw notFound("Video not found");
  const video = data as Video;

  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId };
  const creators = await fetchVisibleProfiles(ctx, [video.creator_id]);
  if (!creators.has(video.creator_id)) {
    throw notFound("Video not found");
  }
  return { video, supabase };
}

/** Enrich a single video with creator/count/viewer-state details. */
export async function enrichOne(
  supabase: Awaited<ReturnType<typeof createClient>>,
  video: Video,
  viewerId: string | null
) {
  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId };
  const [enriched] = await enrichVideos(ctx, [video]);
  return enriched ?? video;
}
