import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { handleRoute, fromPostgrestError } from "@/lib/api-errors";

/**
 * Platform stats for admins. Counts are computed with COUNT(*) over indexed
 * keys (migration 0001 counter strategy); all reads use the service-role
 * client after the is_admin() gate in requireAdmin().
 */
export const GET = handleRoute(async () => {
  const { admin } = await requireAdmin();

  const [users, videos, comments, messages, reportsOpen, reportsTotal] =
    await Promise.all([
      admin.from("profiles").select("id", { count: "exact", head: true }),
      admin.from("videos").select("id", { count: "exact", head: true }),
      admin.from("comments").select("id", { count: "exact", head: true }),
      admin.from("messages").select("id", { count: "exact", head: true }),
      admin
        .from("reports")
        .select("id", { count: "exact", head: true })
        .eq("status", "open"),
      admin.from("reports").select("id", { count: "exact", head: true }),
    ]);

  for (const res of [users, videos, comments, messages, reportsOpen, reportsTotal]) {
    if (res.error) throw fromPostgrestError(res.error);
  }

  return NextResponse.json({
    users: users.count ?? 0,
    videos: videos.count ?? 0,
    comments: comments.count ?? 0,
    messages: messages.count ?? 0,
    reports_open: reportsOpen.count ?? 0,
    reports_total: reportsTotal.count ?? 0,
  });
});
