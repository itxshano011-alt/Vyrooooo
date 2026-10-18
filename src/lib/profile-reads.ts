/**
 * Server-side profile read helpers shared by API routes.
 *
 * These live outside the route modules because Next.js rejects non-route
 * exports (anything besides GET/POST/.../revalidate/dynamic/...) from files
 * under src/app/api/**. The helpers were previously exported from the
 * check-username route module; they are imported by the profile, follows,
 * and users routes.
 */

import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { notFound } from "@/lib/api-errors";
import type { Profile } from "@/lib/db";

async function profileVisibleTo(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profile: Profile,
  viewerId: string | null
): Promise<boolean> {
  if (!profile.is_private) return true;
  if (!viewerId) return false;
  if (viewerId === profile.id) return true;
  const { data: admin } = await supabase.rpc("is_admin");
  if (admin === true) return true;
  const { data: follow } = await supabase
    .from("follows")
    .select("follower_id")
    .eq("follower_id", viewerId)
    .eq("followed_id", profile.id)
    .maybeSingle();
  return follow !== null;
}

/** Load a profile by username and enforce the API visibility rule. */
export async function getVisibleProfileByUsername(
  username: string,
  viewerId: string | null
): Promise<Profile> {
  // Authoritative lookup first: RLS would hide private profiles from
  // non-followers, and we need to distinguish "does not exist" from
  // "exists but not visible" -- both surface as 404 to the caller.
  const { data, error } = await adminClient
    .from("profiles")
    .select("*")
    .eq("username", username)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw notFound("User not found");
  }
  const profile = data as Profile;

  const supabase = await createClient();
  if (viewerId) {
    const { data: blocked } = await supabase.rpc("blocked_between", {
      a: viewerId,
      b: profile.id,
    });
    if (blocked === true) {
      throw notFound("User not found");
    }
  }
  const visible = await profileVisibleTo(supabase, profile, viewerId);
  if (!visible) {
    throw notFound("User not found");
  }
  return profile;
}

/** Public aggregate counts for a profile (COUNT(*); see migration 0001). */
export async function getProfileCounts(profileId: string): Promise<{
  follower_count: number;
  following_count: number;
  video_count: number;
}> {
  // Counts are public aggregate metadata, not private records: they are
  // computed with the admin client so anonymous viewers get real numbers
  // too (the follows edge table is RLS-restricted to authenticated users,
  // which would otherwise zero out counts for logged-out viewers).
  const [followers, following, videos] = await Promise.all([
    adminClient
      .from("follows")
      .select("follower_id", { count: "exact", head: true })
      .eq("followed_id", profileId),
    adminClient
      .from("follows")
      .select("followed_id", { count: "exact", head: true })
      .eq("follower_id", profileId),
    adminClient
      .from("videos")
      .select("id", { count: "exact", head: true })
      .eq("creator_id", profileId)
      .eq("visibility", "public")
      .eq("processing_status", "published")
      .eq("moderation_status", "ok"),
  ]);
  if (followers.error) throw followers.error;
  if (following.error) throw following.error;
  if (videos.error) throw videos.error;
  return {
    follower_count: followers.count ?? 0,
    following_count: following.count ?? 0,
    video_count: videos.count ?? 0,
  };
}
