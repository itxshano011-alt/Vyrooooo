import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { handleRoute, fromPostgrestError } from "@/lib/api-errors";

/**
 * Mark every unread notification as read.
 * Only read_at is written (see the guard trigger note on PATCH
 * /api/notifications).
 */
export const PATCH = handleRoute(async () => {
  const { user } = await requireProfile();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_id", user.id)
    .is("read_at", null)
    .select("id");
  if (error) throw fromPostgrestError(error);

  return NextResponse.json({ updated: (data ?? []).length });
});
