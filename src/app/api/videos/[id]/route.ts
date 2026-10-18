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
import { videoUpdateSchema } from "@/lib/validation";
import { type Video } from "@/lib/db";
import { getViewableVideo, enrichOne } from "@/lib/video-reads";
import { syncVideoHashtags } from "@/lib/video-hashtags";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Video detail. Enforces can_view_video via RLS. */
export const GET = handleRoute(async (_request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const session = await getSessionUser();
  const { video, supabase } = await getViewableVideo(id, session?.user.id ?? null);
  return NextResponse.json({
    video: await enrichOne(supabase, video, session?.user.id ?? null),
  });
});

/**
 * Owner-only update: caption and/or visibility. Hashtags are re-parsed
 * server-side from the new caption. processing_status / moderation_status /
 * creator_id are not accepted here (the DB guard trigger would reject them
 * for non-admins anyway).
 */
export const PATCH = handleRoute(async (request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const { user } = await requireProfile();

  const parsed = videoUpdateSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);

  const supabase = await createClient();
  const { data: existing, error: fetchError } = await supabase
    .from("videos")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw fromPostgrestError(fetchError);
  if (!existing || (existing as Video).creator_id !== user.id) {
    throw notFound("Video not found");
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.caption !== undefined) update.caption = parsed.data.caption;
  if (parsed.data.visibility !== undefined)
    update.visibility = parsed.data.visibility;

  const { data, error } = await supabase
    .from("videos")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw fromPostgrestError(error, "Could not update video");

  if (parsed.data.caption !== undefined) {
    await syncVideoHashtags(supabase, id, parsed.data.caption);
  }

  return NextResponse.json({
    video: await enrichOne(supabase, data as Video, user.id),
  });
});

/**
 * Owner-only delete: removes the storage objects (videos + thumbnail
 * buckets) with the admin client first, then the row through RLS so
 * ownership is enforced by policy, not just by our check.
 */
export const DELETE = handleRoute(async (_request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const { user } = await requireProfile();

  const supabase = await createClient();
  const { data: existing, error: fetchError } = await supabase
    .from("videos")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw fromPostgrestError(fetchError);
  if (!existing || (existing as Video).creator_id !== user.id) {
    throw notFound("Video not found");
  }
  const video = existing as Video;

  // Storage objects are removed with the admin client: the caller already
  // proved ownership above, and this keeps orphaned files from surviving a
  // deleted video.
  const removals: Promise<unknown>[] = [
    adminClient.storage.from("videos").remove([video.storage_path]),
  ];
  if (video.thumbnail_path) {
    removals.push(
      adminClient.storage.from("thumbnails").remove([video.thumbnail_path])
    );
  }
  const results = await Promise.all(removals);
  for (const result of results as { error: { message: string } | null }[]) {
    if (result?.error) {
      throw fromPostgrestError(
        {
          code: "XX000",
          message: result.error.message,
          details: "",
          hint: "",
        },
        "Could not delete video files"
      );
    }
  }

  const { error: deleteError } = await supabase
    .from("videos")
    .delete()
    .eq("id", id);
  if (deleteError) throw fromPostgrestError(deleteError, "Could not delete video");

  return NextResponse.json({ deleted: true });
});
