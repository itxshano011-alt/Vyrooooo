import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  badRequest,
  validationError,
} from "@/lib/api-errors";
import { adminModerateSchema } from "@/lib/validation";

/**
 * Admin moderation actions. Gated by is_admin() via requireAdmin(); all
 * writes use the service-role client.
 *
 * - video + remove:  sets moderation_status='removed', which hides the video
 *   from every feed and detail view (can_view_video requires 'ok').
 * - video + restore: sets moderation_status='ok'.
 * - comment + remove: hard-deletes the comment (clients can only soft-delete
 *   messages; comment hard delete is admin-only).
 * - user + ban:      deletes the auth user; ON DELETE CASCADE removes the
 *   profile and everything below it. Irreversible.
 * Any other target/action combination is rejected with 400.
 */
export const POST = handleRoute(async (request: NextRequest) => {
  const { admin } = await requireAdmin();

  const parsed = adminModerateSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);
  const { target_type, target_id, action } = parsed.data;

  if (target_type === "video" && (action === "remove" || action === "restore")) {
    const moderation_status = action === "remove" ? "removed" : "ok";
    const { data, error } = await admin
      .from("videos")
      .update({ moderation_status })
      .eq("id", target_id)
      .select("id")
      .maybeSingle();
    if (error) throw fromPostgrestError(error, "Could not moderate video");
    if (!data) throw notFound("Video not found");
  } else if (target_type === "comment" && action === "remove") {
    const { data, error } = await admin
      .from("comments")
      .delete()
      .eq("id", target_id)
      .select("id")
      .maybeSingle();
    if (error) throw fromPostgrestError(error, "Could not remove comment");
    if (!data) throw notFound("Comment not found");
  } else if (target_type === "user" && action === "ban") {
    const { error } = await admin.auth.admin.deleteUser(target_id);
    if (error) {
      // Auth admin errors are not PostgrestErrors; map the common case.
      if (error.message.toLowerCase().includes("not found")) {
        throw notFound("User not found");
      }
      throw fromPostgrestError(
        { code: "XX000", message: error.message, details: "", hint: "" },
        "Could not ban user"
      );
    }
  } else {
    throw badRequest(
      `Action '${action}' is not valid for target type '${target_type}'`
    );
  }

  return NextResponse.json({
    moderated: true,
    target_type,
    target_id,
    action,
  });
});
