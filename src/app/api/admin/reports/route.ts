import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  validationError,
} from "@/lib/api-errors";
import type { Report } from "@/lib/db";

const reportListQuerySchema = z.object({
  status: z.enum(["open", "reviewed", "actioned", "dismissed"]).optional(),
});

/**
 * Moderation report queue for admins (?status= to filter).
 * Reporters only ever see their own reports via RLS; this endpoint uses the
 * service-role client after the is_admin() gate.
 */
export const GET = handleRoute(async (request: NextRequest) => {
  const { admin } = await requireAdmin();

  const parsed = reportListQuerySchema.safeParse({
    status: new URL(request.url).searchParams.get("status") ?? undefined,
  });
  if (!parsed.success) throw validationError(parsed.error);

  let query = admin
    .from("reports")
    .select("*")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(50);
  if (parsed.data.status) query = query.eq("status", parsed.data.status);

  const { data, error } = await query;
  if (error) throw fromPostgrestError(error);
  const reports = (data ?? []) as Report[];

  const reporterIds = [
    ...new Set(
      reports
        .map((r) => r.reporter_id)
        .filter((id): id is string => id !== null)
    ),
  ];
  let reporters: Record<string, { id: string; username: string } | null> = {};
  if (reporterIds.length > 0) {
    const { data: rows, error: reporterError } = await admin
      .from("profiles")
      .select("id, username")
      .in("id", reporterIds);
    if (reporterError) throw fromPostgrestError(reporterError);
    reporters = Object.fromEntries(
      ((rows ?? []) as { id: string; username: string }[]).map((r) => [
        r.id,
        { id: r.id, username: r.username },
      ])
    );
  }

  return NextResponse.json({
    reports: reports.map((r) => ({
      ...r,
      reporter: r.reporter_id ? (reporters[r.reporter_id] ?? null) : null,
    })),
  });
});
