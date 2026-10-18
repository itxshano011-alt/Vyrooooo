"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { VideoWithDetails } from "@/lib/db";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { VideoGrid } from "@/components/VideoGrid";

/**
 * Hashtag page: video grid for #tag (GET /api/hashtags/[tag]).
 * The tag is normalized like the write path (lowercase, no '#').
 */
export default function HashtagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag: rawTag } = use(params);
  const router = useRouter();
  const { user } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const tag = rawTag.replace(/^#+/, "").toLowerCase();

  const [videos, setVideos] = useState<VideoWithDetails[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursorToUse: string | null, append: boolean) => {
      try {
        const params = cursorToUse ? `?cursor=${encodeURIComponent(cursorToUse)}` : "";
        const data = await apiRequest<{ tag: string; videos: VideoWithDetails[]; next_cursor: string | null }>(
          `/api/hashtags/${encodeURIComponent(tag)}${params}`
        );
        setVideos((prev) => {
          const merged = append ? [...prev, ...data.videos] : data.videos;
          const seen = new Set<string>();
          return merged.filter((v) => {
            if (seen.has(v.id)) return false;
            seen.add(v.id);
            return true;
          });
        });
        setCursor(data.next_cursor);
        setHasMore(data.next_cursor !== null);
        setError(null);
      } catch (e) {
        setError(errorMessage(e, "Could not load hashtag"));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [tag]
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  return (
    <main className="min-h-dvh bg-surface text-ink">
      <header className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
        <Link href="/home" className="text-xl font-black text-ink">
          VYRO
        </Link>
        {!user && (
          <Button size="sm" onClick={() => router.push("/login")}>
            Log in
          </Button>
        )}
      </header>

      <div className="mx-auto w-full max-w-4xl px-4 pb-16">
        <h1 className="text-3xl font-black text-[var(--color-brand-blue)]">#{tag}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {videos.length > 0
            ? `${videos.length}${hasMore ? "+" : ""} video${videos.length === 1 ? "" : "s"} tagged #${tag}`
            : `Videos tagged #${tag}`}
        </p>

        <div className="mt-6">
          {loading ? (
            <div className="grid grid-cols-3 gap-1 sm:gap-2" aria-label="Loading videos">
              {Array.from({ length: 9 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[3/4]" />
              ))}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-ink-muted">{error}</p>
              <Button variant="secondary" size="sm" onClick={() => { setLoading(true); void load(null, false); }}>
                Retry
              </Button>
            </div>
          ) : videos.length === 0 ? (
            <EmptyState
              title={`No videos tagged #${tag} yet`}
              description="When creators use this hashtag, their videos will show up here."
              actionLabel="Explore videos"
              onAction={() => router.push("/explore")}
            />
          ) : (
            <div className="flex flex-col gap-4">
              <VideoGrid videos={videos} supabase={supabase} />
              {hasMore && (
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={loadingMore}
                    onClick={() => {
                      setLoadingMore(true);
                      void load(cursor, true);
                    }}
                  >
                    Load more
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
