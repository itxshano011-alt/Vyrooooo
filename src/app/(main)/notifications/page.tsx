"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAuth } from "@/hooks/useAuth";
import { subscribeToNotifications } from "@/lib/realtime";
import { timeAgo } from "@/lib/format";
import type {
  NotificationType,
  NotificationWithActor,
} from "@/lib/db";
import { avatarUrl } from "@/components/chat/urls";

const PAGE_SIZE = 30;

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function textFor(n: NotificationWithActor): string {
  const actor = n.actor
    ? n.actor.display_name?.trim() || `@${n.actor.username}`
    : "Someone";
  switch (n.type as NotificationType) {
    case "follow":
      return `${actor} started following you`;
    case "like":
      return `${actor} liked your video`;
    case "comment":
      return `${actor} commented on your video`;
    case "message":
      return `${actor} sent you a message`;
    case "report_update":
      return "There is an update on your report";
    case "moderation":
      return "A moderation action was taken on your content";
    default:
      return "You have a new notification";
  }
}

function deepLinkFor(n: NotificationWithActor): string | null {
  switch (n.type as NotificationType) {
    case "follow":
      return n.actor ? `/profile/${n.actor.username}` : null;
    case "like":
    case "comment":
      return n.video_id ? `/video/${n.video_id}` : null;
    case "message":
      return n.conversation_id ? `/inbox/${n.conversation_id}` : null;
    case "report_update":
    case "moderation":
      return n.video_id ? `/video/${n.video_id}` : null;
    default:
      return null;
  }
}

export default function NotificationsPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();
  const viewerId = profile?.id ?? null;

  const [notifications, setNotifications] = useState<NotificationWithActor[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const fetchPage = useCallback(async (pageCursor: string | null) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (pageCursor) params.set("cursor", pageCursor);
    const res = await fetch(`/api/notifications?${params}`, {
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, "Could not load notifications"));
    }
    const data = (await res.json()) as {
      notifications: NotificationWithActor[];
      unread_count: number;
      next_cursor: string | null;
    };
    setUnreadCount(data.unread_count);
    if (pageCursor) {
      setNotifications((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...data.notifications.filter((n) => !seen.has(n.id))];
      });
    } else {
      setNotifications(data.notifications);
    }
    setCursor(data.next_cursor);
    setHasMore(data.next_cursor !== null);
  }, []);

  const markRead = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setNotifications((prev) =>
      prev.map((n) =>
        ids.includes(n.id) ? { ...n, read_at: new Date().toISOString() } : n
      )
    );
    setUnreadCount((c) => Math.max(0, c - ids.length));
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
    } catch {
      // Optimistic update stands; the next open re-syncs.
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setMarkingAll(true);
    try {
      const res = await fetch("/api/notifications/read-all", {
        method: "PATCH",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res, "Could not mark notifications as read"));
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() }))
      );
      setUnreadCount(0);
    } catch {
      // Keep the button available.
    } finally {
      setMarkingAll(false);
    }
  }, []);

  // Initial load, then mark everything as read once the list is visible.
  useEffect(() => {
    if (authLoading) return;
    if (!viewerId) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        await fetchPage(null);
        if (!cancelled) {
          // Mark-read on open, per the page contract.
          await markAllRead();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load notifications");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, viewerId, fetchPage, markAllRead, router]);

  // Live inserts land at the top of the list.
  useEffect(() => {
    if (!viewerId) return;
    const unsubscribe = subscribeToNotifications(viewerId, (incoming) => {
      setNotifications((prev) => {
        if (prev.some((n) => n.id === incoming.id)) return prev;
        return [
          { ...incoming, actor: null } as NotificationWithActor,
          ...prev,
        ];
      });
      setUnreadCount((c) => c + 1);
    });
    return unsubscribe;
  }, [viewerId]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(cursor);
    } catch {
      // Button stays available.
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, fetchPage]);

  const handleTap = useCallback(
    (n: NotificationWithActor) => {
      if (!n.read_at) void markRead([n.id]);
      const href = deepLinkFor(n);
      if (href) router.push(href);
    },
    [markRead, router]
  );

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="space-y-2 p-4" aria-label="Loading notifications">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl p-2">
              <Skeleton className="h-11 w-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4 rounded" />
                <Skeleton className="h-3 w-1/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (error) {
      return (
        <div className="p-6">
          <EmptyState
            title="Couldn't load notifications"
            description={error}
            actionLabel="Try again"
            onAction={() => window.location.reload()}
          />
        </div>
      );
    }
    if (notifications.length === 0) {
      return (
        <div className="p-6">
          <EmptyState
            title="No notifications yet"
            description="Likes, comments, follows, and messages will show up here."
          />
        </div>
      );
    }
    return (
      <ul className="divide-y divide-border" aria-label="Notifications">
        {notifications.map((n) => {
          const unread = !n.read_at;
          const href = deepLinkFor(n);
          const body = (
            <span className="flex w-full items-center gap-3 px-4 py-3 text-left">
              <Avatar
                src={avatarUrl(n.actor?.avatar_path)}
                name={n.actor?.username ?? "V"}
                size="md"
              />
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-sm ${
                    unread ? "font-semibold text-ink" : "text-ink-muted"
                  }`}
                >
                  {textFor(n)}
                </span>
                <time
                  dateTime={n.created_at}
                  className="text-xs text-ink-muted"
                >
                  {timeAgo(n.created_at)}
                </time>
              </span>
              {unread && (
                <span
                  aria-label="Unread"
                  className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand-blue"
                />
              )}
            </span>
          );
          return (
            <li
              key={n.id}
              className={unread ? "bg-brand-blue/10" : undefined}
            >
              {href ? (
                <Link
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    handleTap(n);
                  }}
                  className="block transition-colors hover:bg-surface-elevated"
                >
                  {body}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => handleTap(n)}
                  className="block w-full transition-colors hover:bg-surface-elevated"
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }, [loading, error, notifications, handleTap]);

  return (
    <div className="mx-auto w-full max-w-2xl pb-8">
      <header className="flex items-center justify-between px-4 pb-2 pt-4">
        <h1 className="text-xl font-bold text-ink">Notifications</h1>
        {unreadCount > 0 && !loading && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void markAllRead()}
            loading={markingAll}
          >
            {markingAll ? "Marking" : `Mark all as read (${unreadCount})`}
          </Button>
        )}
      </header>
      {content}
      {hasMore && !loading && !error && (
        <div className="flex justify-center p-4">
          <Button
            variant="secondary"
            onClick={() => void loadMore()}
            loading={loadingMore}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
