import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { handleRoute } from "@/lib/api-errors";
import {
  getProfileCounts,
  getVisibleProfileByUsername,
} from "@/lib/profile-reads";
import type { ProfileWithCounts } from "@/lib/db";

/**
 * Public profile with real follower/following/video counts.
 * 404 when the user does not exist, the profile is private and the viewer
 * is not the owner/a follower/an admin, or a block exists either way.
 */
export const GET = handleRoute(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ username: string }> }
  ) => {
    const { username } = await params;
    const session = await getSessionUser();
    const viewerId = session?.user.id ?? null;

    const profile = await getVisibleProfileByUsername(username, viewerId);
    const counts = await getProfileCounts(profile.id);

    let is_followed_by_viewer: boolean | null = null;
    let is_following_viewer: boolean | null = null;
    let is_blocked_by_viewer: boolean | null = null;

    if (viewerId && viewerId !== profile.id) {
      const supabase = await createClient();
      const [followed, following, blocked] = await Promise.all([
        supabase
          .from("follows")
          .select("follower_id")
          .eq("follower_id", viewerId)
          .eq("followed_id", profile.id)
          .maybeSingle(),
        supabase
          .from("follows")
          .select("follower_id")
          .eq("follower_id", profile.id)
          .eq("followed_id", viewerId)
          .maybeSingle(),
        supabase
          .from("blocks")
          .select("blocker_id")
          .eq("blocker_id", viewerId)
          .eq("blocked_id", profile.id)
          .maybeSingle(),
      ]);
      is_followed_by_viewer = followed.data !== null;
      is_following_viewer = following.data !== null;
      is_blocked_by_viewer = blocked.data !== null;
    }

    const body: ProfileWithCounts = {
      ...profile,
      ...counts,
      is_followed_by_viewer,
      is_following_viewer,
      is_blocked_by_viewer,
    };
    return NextResponse.json({ profile: body });
  }
);
