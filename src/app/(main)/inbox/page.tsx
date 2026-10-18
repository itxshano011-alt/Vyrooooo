"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ConversationList from "@/components/chat/ConversationList";
import { useAuth } from "@/hooks/useAuth";
import { subscribeToInbox } from "@/lib/realtime";
import type { ConversationWithPreview } from "@/lib/db";

const PAGE_SIZE = 20;

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export default function InboxPage() {
  return (
    <Suspense fallback={<InboxSkeleton />}>
      <InboxPageInner />
    </Suspense>
  );
}

function InboxSkeleton() {
  return (
    <div className="mx-auto w-full max-w-2xl px-3 py-6" aria-label="Loading inbox">
      <div className="mb-4 h-8 w-40 rounded-lg bg-surface-elevated" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="h-12 w-12 animate-pulse rounded-full bg-surface-elevated" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-elevated" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-surface-elevated" />
          </div>
        </div>
      ))}
    </div>
  );
}

function InboxPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { profile, loading: authLoading } = useAuth();
  const viewerId = profile?.id ?? null;

  // Deep link from the profile "Message" button (/inbox?conversation=<id>):
  // hand off to the conversation thread view on mount.
  const pendingConversationId = searchParams.get("conversation");

  const [conversations, setConversations] = useState<ConversationWithPreview[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPage = useCallback(
    async (pageCursor: string | null): Promise<boolean> => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageCursor) params.set("cursor", pageCursor);
      const res = await fetch(`/api/conversations?${params}`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, "Could not load conversations"));
      }
      const data = (await res.json()) as {
        conversations: ConversationWithPreview[];
        next_cursor: string | null;
      };
      if (pageCursor) {
        setConversations((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...data.conversations.filter((c) => !seen.has(c.id))];
        });
      } else {
        setConversations(data.conversations);
      }
      setCursor(data.next_cursor);
      setHasMore(data.next_cursor !== null);
      return true;
    },
    []
  );

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await fetchPage(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load conversations");
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => {
    if (authLoading) return;
    if (!viewerId) {
      router.replace("/login");
      return;
    }
    // Deep link: profile "Message" lands on /inbox?conversation=<id>.
    // Replace (not push) so Back returns to the profile, not this stub.
    if (pendingConversationId) {
      router.replace(`/inbox/${encodeURIComponent(pendingConversationId)}`);
      return;
    }
    void loadInitial();
  }, [authLoading, viewerId, pendingConversationId, loadInitial, router]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(cursor);
    } catch {
      // Keep the button available for another attempt.
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, fetchPage]);

  // Refresh the first page when any conversation ticks (new message bumps
  // updated_at). Debounced so a burst of events causes one refetch, and RLS
  // decides what the viewer may actually see.
  useEffect(() => {
    if (!viewerId) return;
    const unsubscribe = subscribeToInbox(() => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void fetchPage(null).catch(() => {});
      }, 1500);
    });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsubscribe();
    };
  }, [viewerId, fetchPage]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      const peer = c.other_participants[0];
      const haystack = [
        peer?.display_name ?? "",
        peer?.username ?? "",
        c.last_message?.body ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [conversations, query]);

  if (authLoading || (!viewerId && !error)) {
    return <InboxSkeleton />;
  }

  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl flex-col">
      <header className="shrink-0 px-4 pb-2 pt-4">
        <h1 className="text-xl font-bold text-ink">Messages</h1>
      </header>
      <div className="min-h-0 flex-1">
        <ConversationList
          conversations={filtered}
          viewerId={viewerId ?? ""}
          loading={loading}
          loadingMore={loadingMore}
          hasMore={hasMore && !query}
          error={error}
          onRetry={() => void loadInitial()}
          onLoadMore={() => void loadMore()}
          query={query}
          onQueryChange={setQuery}
        />
      </div>
    </div>
  );
}
