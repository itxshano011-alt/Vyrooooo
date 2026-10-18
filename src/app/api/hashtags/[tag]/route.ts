import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import { handleRoute, fromPostgrestError } from "@/lib/api-errors";
import {
  cursorFilter,
  enrichVideos,
  nextCursorFor,
  parsePagination,
  type ReadContext,
  type Video,
} from "@/lib/db";

/**
 * Videos for a hashtag, newest first, cursor-paginated.
 *
 * The tag is normalized exactly like the write path does: lowercase, no
 * leading '#', [a-z0-9_]{1,64} (migration 0004). An unknown or malformed tag
 * returns an empty list rather than an error -- there is simply nothing
 * tagged with it. Only public, published, unflagged videos are returned
 * (RLS can_view_video).
 */
export const GET = handleRoute(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ tag: string }> }
  ) => {
    const { tag: rawTag } = await params;
    const tag = rawTag.replace(/^#+/, "").toLowerCase();

    const session = await getSessionUser();
    const viewerId = session?.user.id ?? null;
    const supabase = await createClient();

    if (!/^[a-z0-9_]{1,64}$/.test(tag)) {
      return NextResponse.json({ tag, videos: [], next_cursor: null });
    }

    const { data: hashtag, error: tagError } = await supabase
      .from("hashtags")
      .select("id")
      .eq("tag", tag)
      .maybeSingle();
    if (tagError) throw fromPostgrestError(tagError);
    if (!hashtag) {
      return NextResponse.json({ tag, videos: [], next_cursor: null });
    }

    const { data: linkRows, error: linkError } = await supabase
      .from("video_hashtags")
      .select("video_id")
      .eq("hashtag_id", (hashtag as { id: string }).id);
    if (linkError) throw fromPostgrestError(linkError);
    const videoIds = ((linkRows ?? []) as { video_id: string }[]).map(
      (r) => r.video_id
    );
    if (videoIds.length === 0) {
      return NextResponse.json({ tag, videos: [], next_cursor: null });
    }

    const { cursor, limit } = parsePagination(
      new URL(request.url).searchParams
    );

    let query = supabase
      .from("videos")
      .select("*")
      .in("id", videoIds)
      .eq("visibility", "public")
      .eq("processing_status", "published")
      .eq("moderation_status", "ok")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    const filter = cursorFilter(cursor);
    if (filter) query = query.or(filter);

    const { data, error } = await query;
    if (error) throw fromPostgrestError(error);
    const videos = (data ?? []) as Video[];

    const ctx: ReadContext = { userClient: supabase, adminClient, viewerId };
    const enriched = await enrichVideos(ctx, videos);

    return NextResponse.json({
      tag,
      videos: enriched,
      next_cursor: nextCursorFor(videos, limit),
    });
  }
);
