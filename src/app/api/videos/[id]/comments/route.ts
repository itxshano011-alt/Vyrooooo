import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser, requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  validationError,
} from "@/lib/api-errors";
import { commentCreateSchema } from "@/lib/validation";
import {
  commentLimiter,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";
import {
  cursorFilter,
  fetchVisibleProfiles,
  nextCursorFor,
  parsePagination,
  type Comment,
  type ReadContext,
} from "@/lib/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Comments are readable by anyone who can view the video (RLS). */
export const GET = handleRoute(async (request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const session = await getSessionUser();
  const viewerId = session?.user.id ?? null;

  const supabase = await createClient();
  const { data: video, error: videoError } = await supabase
    .from("videos")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (videoError) throw fromPostgrestError(videoError);
  if (!video) throw notFound("Video not found");

  const { cursor, limit } = parsePagination(new URL(request.url).searchParams);

  let query = supabase
    .from("comments")
    .select("*")
    .eq("video_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  const filter = cursorFilter(cursor);
  if (filter) query = query.or(filter);

  const { data, error } = await query;
  if (error) throw fromPostgrestError(error);
  const comments = (data ?? []) as Comment[];

  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId };
  const authors = await fetchVisibleProfiles(
    ctx,
    comments.map((c) => c.author_id)
  );

  return NextResponse.json({
    comments: comments
      .map((c) => {
        const author = authors.get(c.author_id);
        if (!author) return null;
        return {
          ...c,
          author: {
            id: author.id,
            username: author.username,
            display_name: author.display_name,
            avatar_path: author.avatar_path,
            verified: author.verified,
          },
        };
      })
      .filter((c) => c !== null),
    next_cursor: nextCursorFor(comments, limit),
  });
});

/** Comment on a video. The INSERT policy requires can_view_video. */
export const POST = handleRoute(async (request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const { user, profile } = await requireProfile();

  const parsed = commentCreateSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);

  enforceRateLimit(commentLimiter, rateLimitKey(user.id, request));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("comments")
    .insert({ video_id: id, author_id: user.id, body: parsed.data.body })
    .select("*")
    .single();
  if (error) {
    // A missing/unviewable video surfaces as a foreign-key or RLS error;
    // normalize it to 404 so callers get a meaningful response.
    if (error.code === "23503" || error.code === "42501") {
      throw notFound("Video not found");
    }
    throw fromPostgrestError(error, "Could not post comment");
  }

  const comment = data as Comment;
  return NextResponse.json(
    {
      comment: {
        ...comment,
        author: {
          id: profile.id,
          username: profile.username,
          display_name: profile.display_name,
          avatar_path: profile.avatar_path,
          verified: profile.verified,
        },
      },
    },
    { status: 201 }
  );
});
