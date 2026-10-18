import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  forbidden,
  validationError,
} from "@/lib/api-errors";
import { commentUpdateSchema } from "@/lib/validation";
import type { Comment } from "@/lib/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function getComment(
  commentId: string
): Promise<{ comment: Comment; supabase: Awaited<ReturnType<typeof createClient>> }> {
  const supabase = await createClient();
  // RLS select requires can_view_video(video_id); hidden videos 404 here.
  const { data, error } = await supabase
    .from("comments")
    .select("*")
    .eq("id", commentId)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  if (!data) throw notFound("Comment not found");
  return { comment: data as Comment, supabase };
}

/** Edit a comment. Author only (the RLS UPDATE policy enforces this too). */
export const PATCH = handleRoute(async (request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const { user } = await requireProfile();

  const parsed = commentUpdateSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);

  const { comment, supabase } = await getComment(id);
  if (comment.author_id !== user.id) {
    throw forbidden("Only the author can edit this comment");
  }

  const { data, error } = await supabase
    .from("comments")
    .update({ body: parsed.data.body })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw fromPostgrestError(error, "Could not update comment");
  if (!data) throw notFound("Comment not found");

  return NextResponse.json({ comment: data });
});

/**
 * Delete a comment. Allowed for the comment author or the video's creator
 * (mirroring the comments_delete_perms RLS policy, minus the admin path --
 * admins use POST /api/admin/moderate).
 */
export const DELETE = handleRoute(async (_request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const { user } = await requireProfile();

  const { comment, supabase } = await getComment(id);

  let allowed = comment.author_id === user.id;
  if (!allowed) {
    const { data: video, error: videoError } = await supabase
      .from("videos")
      .select("creator_id")
      .eq("id", comment.video_id)
      .maybeSingle();
    if (videoError) throw fromPostgrestError(videoError);
    allowed =
      !!video && (video as { creator_id: string }).creator_id === user.id;
  }
  if (!allowed) {
    throw forbidden("Only the author or the video creator can delete this comment");
  }

  const { error } = await supabase.from("comments").delete().eq("id", id);
  if (error) throw fromPostgrestError(error, "Could not delete comment");

  return NextResponse.json({ deleted: true });
});
