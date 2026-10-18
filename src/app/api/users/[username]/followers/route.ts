import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth";
import { handleRoute, fromPostgrestError, unauthorized } from "@/lib/api-errors";
import { getVisibleProfileByUsername } from "@/lib/profile-reads";
import {
  cursorFilter,
  fetchVisibleProfiles,
  nextCursorFor,
  parsePagination,
  type Profile,
} from "@/lib/db";

/**
 * Paginated follower list for a profile. Requires authentication: the
 * follows edge table is RLS-restricted to signed-in users (migration 0008),
 * so anonymous callers get 401 rather than a misleading empty list.
 * Respects the profile visibility gate and block filtering via RLS.
 */
export const GET = handleRoute(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ username: string }> }
  ) => {
    const { username } = await params;
    const { user } = await requireProfile().catch(() => {
      throw unauthorized("Sign in to see follower lists");
    });

    const profile = await getVisibleProfileByUsername(username, user.id);
    const { cursor, limit } = parsePagination(
      new URL(request.url).searchParams
    );

    const supabase = await createClient();
    let query = supabase
      .from("follows")
      .select("follower_id, created_at")
      .eq("followed_id", profile.id)
      .order("created_at", { ascending: false })
      .order("follower_id", { ascending: false })
      .limit(limit);
    const filter = cursorFilter(cursor, "created_at", "follower_id");
    if (filter) query = query.or(filter);

    const { data, error } = await query;
    if (error) throw fromPostgrestError(error);
    const edges = (data ?? []) as { follower_id: string; created_at: string }[];

    const profiles = await fetchVisibleProfiles(
      { userClient: supabase, adminClient, viewerId: user.id },
      edges.map((e) => e.follower_id)
    );
    const followers = edges
      .map((e) => profiles.get(e.follower_id))
      .filter((p): p is Profile => p !== undefined)
      .map((p) => ({
        id: p.id,
        username: p.username,
        display_name: p.display_name,
        avatar_path: p.avatar_path,
        verified: p.verified,
      }));

    return NextResponse.json({
      followers,
      next_cursor: nextCursorFor(
        edges.map((e) => ({ created_at: e.created_at, id: e.follower_id })),
        limit
      ),
    });
  }
);
