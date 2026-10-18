import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  unauthorized,
  validationError,
} from "@/lib/api-errors";
import { feedTypeSchema } from "@/lib/validation";
import {
  cursorFilter,
  enrichVideos,
  nextCursorFor,
  parsePagination,
  type ReadContext,
  type Video,
  type VideoWithDetails,
} from "@/lib/db";

// ---------------------------------------------------------------------------
// FOR YOU RANKING.
//
// score(video) = like_count / (age_hours + 2) ^ 1.5
//
// A recency-blended popularity score: likes push a video up, age drags it
// down with a 1.5 gravity exponent, and the "+2 hours" term softens the
// penalty for brand-new videos so they get a chance to be seen. Old viral
// videos decay instead of dominating the feed forever.
//
// IMPLEMENTATION (honest approximation, documented tradeoffs):
// - Each page scores a window of the CANDIDATE_WINDOW most recent viewable
//   videos older than the cursor, keeps the top `limit`, and advances the
//   cursor past the whole window. Pages therefore partition the recency
//   timeline; low-scoring videos inside an already-returned window never
//   resurface later. This is a deliberate tradeoff: exact global ranking
//   would need a materialized score column (see migration 0001's counter
//   strategy note), which does not exist yet.
// - like_count is read through RLS (migration 0008 restricts video_likes
//   reads to authenticated users), so anonymous viewers rank on recency
//   alone -- every candidate scores 0 and the window order is preserved.
// - Blocked creators are excluded by the videos RLS policy (can_view_video
//   hides content across blocks), not by application filtering.
// ---------------------------------------------------------------------------
const CANDIDATE_WINDOW = 300;
const SCORE_GRAVITY = 1.5;
const SCORE_AGE_OFFSET_HOURS = 2;

function forYouScore(likeCount: number, createdAt: string, now: number): number {
  const ageHours = Math.max(0, (now - Date.parse(createdAt)) / 3_600_000);
  return likeCount / Math.pow(ageHours + SCORE_AGE_OFFSET_HOURS, SCORE_GRAVITY);
}

const feedQuerySchema = z.object({
  type: feedTypeSchema.default("foryou"),
});

type FeedType = z.infer<typeof feedQuerySchema>["type"];

export const GET = handleRoute(async (request: NextRequest) => {
  const searchParams = new URL(request.url).searchParams;
  const session = await getSessionUser();
  const viewerId = session?.user.id ?? null;

  const typeParsed = feedQuerySchema.safeParse({
    type: searchParams.get("type") ?? undefined,
  });
  if (!typeParsed.success) throw validationError(typeParsed.error);
  const type: FeedType = typeParsed.data.type;

  const { cursor, limit } = parsePagination(searchParams);

  if (type === "following" && !viewerId) {
    throw unauthorized("Sign in to see your Following feed");
  }

  const supabase = await createClient();
  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId };

  let videos: Video[];

  if (type === "foryou") {
    videos = await forYouCandidates(supabase, cursor);
  } else if (type === "following") {
    videos = await followingCandidates(supabase, viewerId as string, cursor, limit);
  } else {
    videos = await latestCandidates(supabase, cursor, limit);
  }

  const enriched = await enrichVideos(ctx, videos);

  return NextResponse.json({
    videos: type === "foryou" ? rankForYou(enriched, limit) : enriched,
    next_cursor: nextCursorFor(videos, type === "foryou" ? CANDIDATE_WINDOW : limit),
  });
});

/** Base filter every feed shares: viewable public videos, RLS-enforced. */
function baseFeedQuery(
  supabase: Awaited<ReturnType<typeof createClient>>,
  cursor: { created_at: string; id: string } | null,
  window: number
) {
  let query = supabase
    .from("videos")
    .select("*")
    .eq("visibility", "public")
    .eq("processing_status", "published")
    .eq("moderation_status", "ok")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(window);
  const filter = cursorFilter(cursor);
  if (filter) query = query.or(filter);
  return query;
}

async function runFeedQuery(
  query: ReturnType<typeof baseFeedQuery>
): Promise<Video[]> {
  const { data, error } = await query;
  if (error) throw fromPostgrestError(error);
  return (data ?? []) as Video[];
}

/** Latest public videos, newest first. */
function latestCandidates(
  supabase: Awaited<ReturnType<typeof createClient>>,
  cursor: { created_at: string; id: string } | null,
  limit: number
): Promise<Video[]> {
  return runFeedQuery(baseFeedQuery(supabase, cursor, limit));
}

/** Public videos from accounts the viewer follows, newest first. */
async function followingCandidates(
  supabase: Awaited<ReturnType<typeof createClient>>,
  viewerId: string,
  cursor: { created_at: string; id: string } | null,
  limit: number
): Promise<Video[]> {
  const { data: followRows, error: followError } = await supabase
    .from("follows")
    .select("followed_id")
    .eq("follower_id", viewerId);
  if (followError) throw fromPostgrestError(followError);
  const followedIds = ((followRows ?? []) as { followed_id: string }[]).map(
    (r) => r.followed_id
  );
  if (followedIds.length === 0) return [];

  let query = supabase
    .from("videos")
    .select("*")
    .eq("visibility", "public")
    .eq("processing_status", "published")
    .eq("moderation_status", "ok")
    .in("creator_id", followedIds)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  const filter = cursorFilter(cursor);
  if (filter) query = query.or(filter);
  return runFeedQuery(query);
}

/** The raw recency window that For You scores in memory. */
function forYouCandidates(
  supabase: Awaited<ReturnType<typeof createClient>>,
  cursor: { created_at: string; id: string } | null
): Promise<Video[]> {
  return runFeedQuery(baseFeedQuery(supabase, cursor, CANDIDATE_WINDOW));
}

/** Score the enriched window and keep the top `limit`. */
function rankForYou(
  enriched: VideoWithDetails[],
  limit: number
): VideoWithDetails[] {
  const now = Date.now();
  return enriched
    .map((v) => ({
      video: v,
      score: forYouScore(v.like_count, v.created_at, now),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.video);
}
