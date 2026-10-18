import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  validationError,
} from "@/lib/api-errors";
import { adminReportUpdateSchema } from "@/lib/validation";

/**
 * Move a report through the moderation workflow.
 * Body: { status: 'reviewed' | 'actioned' | 'dismissed' }.
 * reviewed_at is stamped the first time a report leaves 'open'.
 * Gated by is_admin(); reporters cannot touch status (migration 0008).
 */
export const PATCH = handleRoute(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id } = await params;
    const { admin } = await requireAdmin();

    const parsed = adminReportUpdateSchema.safeParse(await request.json());
    if (!parsed.success) throw validationError(parsed.error);

    const { data: existing, error: fetchError } = await admin
      .from("reports")
      .select("id, status, reviewed_at")
      .eq("id", id)
      .maybeSingle();
    if (fetchError) throw fromPostgrestError(fetchError);
    if (!existing) throw notFound("Report not found");

    const update: Record<string, unknown> = { status: parsed.data.status };
    const prev = existing as { status: string; reviewed_at: string | null };
    if (prev.status === "open" && prev.reviewed_at === null) {
      update.reviewed_at = new Date().toISOString();
    }

    const { data, error } = await admin
      .from("reports")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw fromPostgrestError(error, "Could not update report");
    if (!data) throw notFound("Report not found");

    return NextResponse.json({ report: data });
  }
);
