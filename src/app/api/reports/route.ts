import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  validationError,
} from "@/lib/api-errors";
import { reportSchema } from "@/lib/validation";

/**
 * File a moderation report against a user, video, or comment.
 * The target must exist and be visible to the reporter (checked through
 * RLS); reporters can only file as themselves and only see their own
 * reports afterwards (migration 0008). Status workflow is admin-managed.
 */
export const POST = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  const parsed = reportSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);
  const { target_type, target_id, reason } = parsed.data;

  const supabase = await createClient();

  const table =
    target_type === "user"
      ? "profiles"
      : target_type === "video"
        ? "videos"
        : "comments";
  const { data: target, error: targetError } = await supabase
    .from(table)
    .select("id")
    .eq("id", target_id)
    .maybeSingle();
  if (targetError) throw fromPostgrestError(targetError);
  if (!target) throw notFound("Reported content not found");

  const { data, error } = await supabase
    .from("reports")
    .insert({
      reporter_id: user.id,
      target_type,
      target_id,
      reason,
    })
    .select("*")
    .single();
  if (error) throw fromPostgrestError(error, "Could not file report");

  return NextResponse.json({ report: data }, { status: 201 });
});
