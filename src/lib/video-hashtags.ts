/**
 * Server-side hashtag sync shared by the video API routes.
 *
 * This lives outside the route modules because Next.js rejects non-route
 * exports (anything besides GET/POST/.../revalidate/dynamic/...) from files
 * under src/app/api/**. Used by POST /api/videos and PATCH
 * /api/videos/[id].
 */

import { createClient } from "@/lib/supabase/server";
import { fromPostgrestError } from "@/lib/api-errors";
import { extractHashtags } from "@/lib/validation";

/**
 * Sync the video_hashtags mapping for a video from its caption.
 * Tags are extracted server-side (never trusted from the client).
 */
export async function syncVideoHashtags(
  supabase: Awaited<ReturnType<typeof createClient>>,
  videoId: string,
  caption: string | null
): Promise<void> {
  const tags = extractHashtags(caption);

  const { error: deleteError } = await supabase
    .from("video_hashtags")
    .delete()
    .eq("video_id", videoId);
  if (deleteError) throw fromPostgrestError(deleteError);
  if (tags.length === 0) return;

  // Upsert tags (authenticated users may introduce tags per migration 0008);
  // ignoreDuplicates makes concurrent identical inserts safe.
  const { error: tagError } = await supabase
    .from("hashtags")
    .upsert(
      tags.map((tag) => ({ tag })),
      { onConflict: "tag", ignoreDuplicates: true }
    );
  if (tagError) throw fromPostgrestError(tagError);

  const { data: tagRows, error: tagSelectError } = await supabase
    .from("hashtags")
    .select("id")
    .in("tag", tags);
  if (tagSelectError) throw fromPostgrestError(tagSelectError);

  const links = ((tagRows ?? []) as { id: string }[]).map((t) => ({
    video_id: videoId,
    hashtag_id: t.id,
  }));
  if (links.length > 0) {
    const { error: linkError } = await supabase
      .from("video_hashtags")
      .upsert(links, { onConflict: "video_id,hashtag_id", ignoreDuplicates: true });
    if (linkError) throw fromPostgrestError(linkError);
  }
}
