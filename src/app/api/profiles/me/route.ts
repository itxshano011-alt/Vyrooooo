import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  badRequest,
  forbidden,
  validationError,
} from "@/lib/api-errors";
import { profileUpdateSchema } from "@/lib/validation";
import { storagePathOwner } from "@/lib/db";
import { getProfileCounts } from "@/lib/profile-reads";

/**
 * The caller's own profile with real counts.
 */
export const GET = handleRoute(async () => {
  const { user, profile } = await requireProfile();
  const counts = await getProfileCounts(user.id);
  return NextResponse.json({
    profile: {
      ...profile,
      ...counts,
      is_followed_by_viewer: null,
      is_following_viewer: null,
      is_blocked_by_viewer: null,
    },
  });
});

/** Build a single-field ZodError for business-rule validation failures. */
function fieldError(path: string, message: string): ZodError {
  return new ZodError([
    {
      code: "custom",
      path: [path],
      message,
      params: undefined,
    },
  ]);
}

/**
 * Update the caller's profile: display_name, bio (<=160), website_url,
 * username (with availability check), is_private, avatar_path.
 *
 * The verified flag cannot be changed here: the guard trigger in migration
 * 0002 rejects it for non-admins, and it is not accepted as input at all.
 */
export const PATCH = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  const parsed = profileUpdateSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);
  const input = parsed.data;

  // Username change: authoritative availability check (private profiles
  // count as taken, since RLS would hide them from a caller-scoped query).
  if (input.username !== undefined) {
    const { data: existing, error } = await adminClient
      .from("profiles")
      .select("id")
      .eq("username", input.username)
      .neq("id", user.id)
      .maybeSingle();
    if (error) throw fromPostgrestError(error);
    if (existing) {
      throw validationError(fieldError("username", "Username is already taken"));
    }
  }

  // avatar_path must live under the caller's own storage prefix, matching
  // the path convention the storage RLS policies enforce (migration 0007).
  if (input.avatar_path !== undefined && input.avatar_path !== null) {
    const owner = storagePathOwner(input.avatar_path);
    if (owner !== user.id) {
      throw forbidden("avatar_path must be a file you uploaded");
    }
  }

  const update: Record<string, unknown> = {};
  if (input.display_name !== undefined) {
    update.display_name =
      input.display_name === null || input.display_name.trim() === ""
        ? null
        : input.display_name.trim();
  }
  if (input.bio !== undefined) update.bio = input.bio;
  if (input.website_url !== undefined) update.website_url = input.website_url;
  if (input.username !== undefined) update.username = input.username;
  if (input.is_private !== undefined) update.is_private = input.is_private;
  if (input.avatar_path !== undefined) update.avatar_path = input.avatar_path;

  if (Object.keys(update).length === 0) {
    throw badRequest("Nothing to update");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update(update)
    .eq("id", user.id)
    .select("*")
    .single();
  if (error) throw fromPostgrestError(error, "Could not update profile");
  if (!data) throw notFound("Profile not found");

  const counts = await getProfileCounts(user.id);
  return NextResponse.json({ profile: { ...data, ...counts } });
});
