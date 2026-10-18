"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VideoWithDetails } from "@/lib/db";
import { thumbnailUrl } from "@/lib/media";
import { createClient } from "@/lib/supabase/client";
import { useFeed } from "@/hooks/useFeed";
import { useIntersection } from "@/hooks/useIntersection";
import { VideoCard } from "@/components/VideoCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";

/**
 * Vertical snap-scroll video feed.
 *
 * Props:
 *   fetchPage(cursor): Promise<{ items: VideoWithDetails[]; next_cursor }> — cursor page fetcher (see useFeed.videoPageFetcher).
 *   feedKey: change to reset the feed (e.g. switching tabs).
 *   onOpenComments(video), onShare(video): sheet/dialog openers owned by the page.
 *   emptyTitle / emptyDescription: empty-state copy.
 *
 * - One video per viewport (snap). The focused card autoplays; cards more
 *   than one step away render a thumbnail placeholder (preloads neighbors).
 * - Loads the next page when the focused index nears the end.
 */
export function Feed({
  fetchPage,
  feedKey,
  onOpenComments,
  onShare,
  emptyTitle = "Nothing here yet",
  emptyDescription = "Be the first to post a video.",
}: {
  fetchPage: (cursor: string | null) => Promise<{ items: VideoWithDetails[]; next_cursor: string | null }>;
  feedKey: string;
  onOpenComments: (video: VideoWithDetails) => void;
  onShare: (video: VideoWithDetails) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const fetcher = useMemo(() => fetchPage, [feedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const { items, loading, loadingMore, error, retry, loadMore, hasMore } = useFeed<VideoWithDetails>(fetcher, [feedKey]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Load more when the focused card is within 3 of the end.
  useEffect(() => {
    if (hasMore && !loading && !loadingMore && activeIndex >= items.length - 3) {
      loadMore();
    }
  }, [activeIndex, items.length, hasMore, loading, loadingMore, loadMore]);

  if (loading) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-black">
        <Skeleton className="h-3/4 w-full max-w-md" label="Loading feed" />
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-black px-6 text-center">
        <p className="text-white">Could not load the feed.</p>
        <p className="text-sm text-white/60">{error.message}</p>
        <Button variant="secondary" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface">
        <EmptyState title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }

  return (
    <div className="h-full w-full snap-y snap-mandatory overflow-y-auto bg-black">
      {items.map((video, index) => (
        <FeedItem
          key={video.id}
          video={video}
          index={index}
          active={index === activeIndex}
          preload={Math.abs(index - activeIndex) <= 1}
          onVisible={() => setActiveIndex(index)}
          onOpenComments={onOpenComments}
          onShare={onShare}
        />
      ))}
      {loadingMore && (
        <div className="flex h-24 snap-start items-center justify-center">
          <Skeleton className="h-12 w-12 rounded-full" label="Loading more videos" />
        </div>
      )}
    </div>
  );
}

function FeedItem({
  video,
  index,
  active,
  preload,
  onVisible,
  onOpenComments,
  onShare,
}: {
  video: VideoWithDetails;
  index: number;
  active: boolean;
  preload: boolean;
  onVisible: () => void;
  onOpenComments: (v: VideoWithDetails) => void;
  onShare: (v: VideoWithDetails) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [ref, isVisible] = useIntersection<HTMLDivElement>({ threshold: 0.6 });
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    if (isVisible) onVisibleRef.current();
  }, [isVisible]);

  const poster = thumbnailUrl(supabase, video.thumbnail_path);

  return (
    <div ref={ref} className="h-full w-full snap-start snap-always" data-index={index}>
      {preload ? (
        <VideoCard video={video} active={active} onOpenComments={onOpenComments} onShare={onShare} />
      ) : (
        <div className="relative flex h-full w-full items-center justify-center bg-black">
          {poster && <img src={poster} alt="" className="h-full w-full object-cover opacity-60" />}
        </div>
      )}
    </div>
  );
}
