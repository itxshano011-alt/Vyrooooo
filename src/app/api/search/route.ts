import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import { handleRoute, fromPostgrestError, validationError } from "@/lib/api-errors";
import { searchSchema } from "@/lib/validation";
import {
  enrichVideos,
  fetchVisibleProfiles,
  type Profile,
  type ReadContext,
  type Video,
} from "@/lib/db";

const SEARCH_LIMIT = 20;

/**
 * Escape LIKE wildcards in a user-supplied term so "%"/"_" match literally.
 */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Additionally strip PostgREST `or()` metacharacters (commas separate
 * conditions, parentheses group them); a search term containing them would
 * corrupt the filter or allow filter injection.
 */
function sanitizeOrTerm(value: string): string {
  return escapeLikeWildcards(value).replace(/[,()]/g, "");
}

/**
 * Search users, hashtags, or videos (?q=&type=).
 *
 * - q must be at least 2 characters (validated; the client debounces).
 * - Private content never leaks: every read goes through the viewer's
 *   RLS-scoped client (can_view_profile / can_view_video), and results are
 *   additionally passed through the API visibility helpers.
 * - The trigram GIN indexes from migrations 0002/0004 accelerate the
 *   ILIKE '%q%' patterns below.
 */
export const GET = handleRoute(async (request: NextRequest) => {
  const searchParams = new URL(request.url).searchParams;
  const parsed = searchSchema.safeParse({
    q: searchParams.get("q") ?? "",
    type: searchParams.get("type") ?? undefined,
  });
  if (!parsed.success) throw validationError(parsed.error);
  const { q, type } = parsed.data;

  const session = await getSessionUser();
  const viewerId = session?.user.id ?? null;
  const supabase = await createClient();
  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId };

  if (type === "users") {
    const term = sanitizeOrTerm(q);
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .or(`username.ilike.%${term}%,display_name.ilike.%${term}%`)
      .order("username", { ascending: true })
      .limit(SEARCH_LIMIT);
    if (error) throw fromPostgrestError(error);
    const rows = (data ?? []) as Profile[];
    const visible = await fetchVisibleProfiles(
      ctx,
      rows.map((r) => r.id)
    );
    return NextResponse.json({
      users: rows
        .filter((r) => visible.has(r.id))
        .map((r) => {
          const p = visible.get(r.id) as Profile;
          return {
            id: p.id,
            username: p.username,
            display_name: p.display_name,
            avatar_path: p.avatar_path,
            verified: p.verified,
          };
        }),
    });
  }

  if (type === "hashtags") {
    const { data, error } = await supabase
      .from("hashtags")
      .select("tag")
      .ilike("tag", `%${escapeLikeWildcards(q)}%`)
      .order("tag", { ascending: true })
      .limit(SEARCH_LIMIT);
    if (error) throw fromPostgrestError(error);
    return NextResponse.json({
      hashtags: ((data ?? []) as { tag: string }[]).map((r) => r.tag),
    });
  }

  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .ilike("caption", `%${escapeLikeWildcards(q)}%`)
    .eq("visibility", "public")
    .eq("processing_status", "published")
    .eq("moderation_status", "ok")
    .order("created_at", { ascending: false })
    .limit(SEARCH_LIMIT);
  if (error) throw fromPostgrestError(error);
  const videos = (data ?? []) as Video[];
  return NextResponse.json({ videos: await enrichVideos(ctx, videos) });
});
