"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { useAuth } from "@/hooks/useAuth";
import { timeAgo } from "@/lib/format";
import { formatFullDateTime } from "@/components/chat/dates";
import type { Report, ReportStatus, ReportTargetType } from "@/lib/db";

interface AdminStats {
  users: number;
  videos: number;
  comments: number;
  messages: number;
  reports_open: number;
  reports_total: number;
}

interface ReportWithReporter extends Report {
  reporter: { id: string; username: string } | null;
}

type ModerateAction = "remove" | "restore" | "ban";

const STATUS_TABS: { id: ReportStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "reviewed", label: "Reviewed" },
  { id: "actioned", label: "Actioned" },
  { id: "dismissed", label: "Dismissed" },
];

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function targetLabel(targetType: ReportTargetType): string {
  return targetType === "user" ? "User" : targetType === "video" ? "Video" : "Comment";
}

/** Moderation actions available per report target type. */
function actionsFor(
  targetType: ReportTargetType
): { action: ModerateAction; label: string; danger: boolean }[] {
  switch (targetType) {
    case "video":
      return [
        { action: "remove", label: "Remove video", danger: true },
        { action: "restore", label: "Restore video", danger: false },
      ];
    case "comment":
      return [{ action: "remove", label: "Remove comment", danger: true }];
    case "user":
      return [{ action: "ban", label: "Ban user", danger: true }];
  }
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-surface-elevated p-4">
      <p className="text-2xl font-bold tabular-nums text-ink">{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-ink-muted">{label}</p>
    </div>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();
  const viewerId = profile?.id ?? null;

  /** null = unknown, false = not an admin (API returned 403). */
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [reports, setReports] = useState<ReportWithReporter[]>([]);
  const [status, setStatus] = useState<ReportStatus>("open");
  const [loading, setLoading] = useState(true);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    report: ReportWithReporter;
    action: ModerateAction;
    label: string;
  } | null>(null);

  const loadReports = useCallback(async (nextStatus: ReportStatus) => {
    const res = await fetch(`/api/admin/reports?status=${nextStatus}`, {
      credentials: "include",
    });
    if (res.status === 403) {
      setIsAdmin(false);
      return;
    }
    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, "Could not load reports"));
    }
    const data = (await res.json()) as { reports: ReportWithReporter[] };
    setReports(data.reports);
  }, []);

  const loadAll = useCallback(
    async (nextStatus: ReportStatus) => {
      setLoading(true);
      setError(null);
      try {
        const statsRes = await fetch("/api/admin/stats", {
          credentials: "include",
        });
        if (statsRes.status === 403) {
          // Admin status is never read from client-side values; the API
          // decides via its own 403.
          setIsAdmin(false);
          return;
        }
        if (!statsRes.ok) {
          throw new Error(await apiErrorMessage(statsRes, "Could not load stats"));
        }
        setIsAdmin(true);
        setStats((await statsRes.json()) as AdminStats);
        await loadReports(nextStatus);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load admin data");
      } finally {
        setLoading(false);
        setReportsLoading(false);
      }
    },
    [loadReports]
  );

  useEffect(() => {
    if (authLoading) return;
    if (!viewerId) {
      router.replace("/login");
      return;
    }
    void loadAll(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, viewerId]);

  const handleStatusChange = useCallback(
    (next: ReportStatus) => {
      setStatus(next);
      setReportsLoading(true);
      setError(null);
      loadReports(next)
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : "Could not load reports")
        )
        .finally(() => setReportsLoading(false));
    },
    [loadReports]
  );

  const setReportStatus = useCallback(
    async (report: ReportWithReporter, nextStatus: Exclude<ReportStatus, "open">) => {
      const key = `status-${report.id}`;
      setActing(key);
      setActionError(null);
      try {
        const res = await fetch(`/api/admin/reports/${report.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status: nextStatus }),
        });
        if (!res.ok) {
          throw new Error(await apiErrorMessage(res, "Could not update report"));
        }
        // The report leaves the current tab; refresh the queue and stats.
        await loadAll(status);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Could not update report");
      } finally {
        setActing(null);
      }
    },
    [loadAll, status]
  );

  const runModeration = useCallback(
    async (report: ReportWithReporter, action: ModerateAction) => {
      const key = `mod-${report.id}-${action}`;
      setActing(key);
      setActionError(null);
      setConfirm(null);
      try {
        const res = await fetch("/api/admin/moderate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            target_type: report.target_type,
            target_id: report.target_id,
            action,
          }),
        });
        if (!res.ok) {
          throw new Error(await apiErrorMessage(res, "Moderation action failed"));
        }
        // Mark the report actioned once its target was handled.
        const statusRes = await fetch(`/api/admin/reports/${report.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status: "actioned" }),
        });
        if (!statusRes.ok) {
          throw new Error(
            await apiErrorMessage(
              statusRes,
              "Action succeeded but the report could not be marked actioned"
            )
          );
        }
        await loadAll(status);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Moderation action failed");
      } finally {
        setActing(null);
      }
    },
    [loadAll, status]
  );

  if (authLoading || isAdmin === null) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4" aria-label="Loading admin">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (isAdmin === false) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center p-10">
        <EmptyState
          title="Admin access required"
          description="You don't have permission to view this page. If you believe this is a mistake, contact the platform owner."
          actionLabel="Back to home"
          onAction={() => router.push("/home")}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 pb-10">
      <header className="flex items-center justify-between pt-2">
        <h1 className="text-xl font-bold text-ink">Admin</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void loadAll(status)}
          loading={loading}
        >
          Refresh
        </Button>
      </header>

      {error && (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4">
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => void loadAll(status)}
          >
            Try again
          </Button>
        </div>
      )}

      {/* Stats */}
      <section aria-label="Platform statistics">
        {stats ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="Users" value={stats.users} />
            <StatCard label="Videos" value={stats.videos} />
            <StatCard label="Comments" value={stats.comments} />
            <StatCard label="Messages" value={stats.messages} />
            <StatCard label="Open reports" value={stats.reports_open} />
            <StatCard label="Total reports" value={stats.reports_total} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
        )}
      </section>

      {/* Reports queue */}
      <section aria-label="Report queue" className="space-y-3">
        <h2 className="text-base font-semibold text-ink">Reports</h2>
        <Tabs
          tabs={STATUS_TABS}
          activeId={status}
          onChange={handleStatusChange}
          ariaLabel="Report status filter"
        />
        {actionError && (
          <p role="alert" className="text-sm text-red-400">
            {actionError}
          </p>
        )}
        {reportsLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-2xl" />
            ))}
          </div>
        ) : reports.length === 0 ? (
          <EmptyState
            title={`No ${status} reports`}
            description="New reports from users will appear here."
          />
        ) : (
          <ul className="space-y-3">
            {reports.map((report) => (
              <li
                key={report.id}
                className="rounded-2xl border border-border bg-surface-elevated p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      {targetLabel(report.target_type)}{" "}
                      <span className="font-mono text-xs text-ink-muted">
                        {report.target_id.slice(0, 8)}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-ink">
                      {report.reason}
                    </p>
                    <p className="mt-2 text-xs text-ink-muted">
                      Reported by{" "}
                      {report.reporter ? `@${report.reporter.username}` : "anonymous"} ·{" "}
                      <time
                        dateTime={report.created_at}
                        title={formatFullDateTime(report.created_at)}
                      >
                        {timeAgo(report.created_at)}
                      </time>
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-surface px-2 py-1 text-[11px] capitalize text-ink-muted">
                    {report.status}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                  {report.status === "open" && (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={acting !== null}
                        loading={acting === `status-${report.id}`}
                        onClick={() => void setReportStatus(report, "reviewed")}
                      >
                        Mark reviewed
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={acting !== null}
                        onClick={() => void setReportStatus(report, "dismissed")}
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                  {actionsFor(report.target_type).map(({ action, label, danger }) => (
                    <Button
                      key={action}
                      variant={danger ? "danger" : "secondary"}
                      size="sm"
                      disabled={acting !== null}
                      loading={acting === `mod-${report.id}-${action}`}
                      onClick={() => setConfirm({ report, action, label })}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Moderation confirm dialog */}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? `${confirm.label}?` : "Confirm"}
      >
        <p className="mb-4 text-sm text-ink-muted">
          {confirm?.action === "ban"
            ? "Banning deletes the user account and everything they created. This is irreversible."
            : "This hides the content from the platform immediately."}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={acting !== null}
            onClick={() => {
              if (confirm) void runModeration(confirm.report, confirm.action);
            }}
          >
            {confirm?.label ?? "Confirm"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
