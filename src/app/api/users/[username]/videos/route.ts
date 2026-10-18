import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import { handleRoute, fromPostgrestError } from "@/lib/api-errors";
import { getVisibleProfileByUsername } from "@/lib/profile-reads";
import {
  cursorFilter,
  enrichVideos,
  nextCursorFor,
  parsePagination,
  type ReadContext,
  type Video,
} from "@/lib/db";

/**
 * A user's videos, newest first, cursor-paginated.
 *
 * Visibility comes from the videos RLS policy (can_view_video): public +
 * published + unflagged videos for everyone, plus private videos for the
 * owner. Blocked creators are hidden automatically. The profile-level gate
 * (private profile + not follower -> 404) is enforced first.
 */
export const GET = handleRoute(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ username: string }> }
  ) => {
    const { username } = await params;
    const session = await getSessionUser();
    const viewerId = session?.user.id ?? null;

    const profile = await getVisibleProfileByUsername(username, viewerId);
    const { cursor, limit } = parsePagination(
      new URL(request.url).searchParams
    );

    const supabase = await createClient();
    let query = supabase
      .from("videos")
      .select("*")
      .eq("creator_id", profile.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    const filter = cursorFilter(cursor);
    if (filter) query = query.or(filter);

    const { data, error } = await query;
    if (error) throw fromPostgrestError(error);
    const videos = (data ?? []) as Video[];

    const ctx: ReadContext = {
      userClient: supabase,
      adminClient,
      viewerId,
    };
    const enriched = await enrichVideos(ctx, videos);

    return NextResponse.json({
      videos: enriched,
      next_cursor: nextCursorFor(videos, limit),
    });
  }
);
