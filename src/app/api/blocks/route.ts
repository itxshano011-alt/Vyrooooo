import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  badRequest,
  validationError,
} from "@/lib/api-errors";
import { blockSchema } from "@/lib/validation";
import type { Block, Profile } from "@/lib/db";

/**
 * The caller's block list. Blocked users' profiles are hidden from the
 * caller's RLS-scoped client by design (can_view_profile hides profiles
 * across blocks), so display fields are read with the admin client -- this
 * is the caller's own list, and no other private data is exposed.
 */
export const GET = handleRoute(async () => {
  const { user } = await requireProfile();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("blocks")
    .select("*")
    .eq("blocker_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw fromPostgrestError(error);
  const blocks = (data ?? []) as Block[];

  const { data: profiles, error: profileError } = await adminClient
    .from("profiles")
    .select("id, username, display_name, avatar_path")
    .in(
      "id",
      blocks.map((b) => b.blocked_id)
    );
  if (profileError) throw fromPostgrestError(profileError);
  const byId = new Map(
    ((profiles ?? []) as Pick<
      Profile,
      "id" | "username" | "display_name" | "avatar_path"
    >[]).map((p) => [p.id, p])
  );

  return NextResponse.json({
    blocks: blocks.map((b) => ({
      blocked_id: b.blocked_id,
      created_at: b.created_at,
      profile: byId.get(b.blocked_id) ?? null,
    })),
  });
});

/**
 * Block a user. Idempotent: blocking twice still returns success.
 * The DB CHECK rejects self-blocks; RLS scopes blocker_id to the caller.
 */
export const POST = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  const parsed = blockSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);
  const targetId = parsed.data.user_id;

  if (targetId === user.id) {
    throw badRequest("You cannot block yourself");
  }

  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id")
    .eq("id", targetId)
    .maybeSingle();
  if (targetError) throw fromPostgrestError(targetError);
  if (!target) throw notFound("User not found");

  const supabase = await createClient();
  const { error } = await supabase
    .from("blocks")
    .insert({ blocker_id: user.id, blocked_id: targetId });
  if (error && error.code !== "23505") {
    // 23505 (already blocked) is swallowed for idempotency.
    throw fromPostgrestError(error, "Could not block user");
  }

  return NextResponse.json({ blocked: true });
});

/** Unblock a user (?user_id=). Idempotent. */
export const DELETE = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  const parsed = blockSchema.safeParse({
    user_id: new URL(request.url).searchParams.get("user_id"),
  });
  if (!parsed.success) throw validationError(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase
    .from("blocks")
    .delete()
    .eq("blocker_id", user.id)
    .eq("blocked_id", parsed.data.user_id);
  if (error) throw fromPostgrestError(error, "Could not unblock user");

  return NextResponse.json({ blocked: false });
});
