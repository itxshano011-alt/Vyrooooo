"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { VideoWithDetails } from "@/lib/db";
import { videoPageFetcher } from "@/hooks/useFeed";
import { useAuth } from "@/hooks/useAuth";
import { Feed } from "@/components/Feed";
import { Tabs } from "@/components/ui/Tabs";
import { CommentsSheet } from "@/components/CommentsSheet";
import { ShareDialog } from "@/components/ShareDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

type FeedTab = "foryou" | "following" | "latest";

const TABS: { id: FeedTab; label: string }[] = [
  { id: "foryou", label: "For You" },
  { id: "following", label: "Following" },
  { id: "latest", label: "Latest" },
];

/**
 * Home feed with For You / Following / Latest tabs (GET /api/feed?type=...).
 * Owns the CommentsSheet + ShareDialog state for the feed.
 * The Following tab requires sign-in; anonymous viewers get a prompt.
 */
export default function HomePage() {
  return (
    <Suspense fallback={<div className="h-dvh bg-black" />}>
      <HomeFeed />
    </Suspense>
  );
}

function HomeFeed() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const initialTab = ((): FeedTab => {
    const t = searchParams.get("tab");
    return t === "following" || t === "latest" ? t : "foryou";
  })();
  const [tab, setTab] = useState<FeedTab>(initialTab);

  const [commentsVideo, setCommentsVideo] = useState<VideoWithDetails | null>(null);
  const [shareVideo, setShareVideo] = useState<VideoWithDetails | null>(null);

  const fetchPage = useMemo(
    () => videoPageFetcher<VideoWithDetails>(`/api/feed?type=${tab}`),
    [tab]
  );

  const handleTabChange = useCallback((next: FeedTab) => {
    setTab(next);
    router.replace(`/home?tab=${next}`, { scroll: false });
  }, [router]);

  const handleCommentCount = useCallback((_videoId: string, _delta: number) => {
    // Feed cards carry their own counts; the sheet's live count is enough.
  }, []);

  if (!authLoading && tab === "following" && !user) {
    return (
      <div className="flex h-[calc(100dvh-64px)] flex-col bg-surface md:h-dvh">
        <div className="flex justify-center border-b border-border py-3">
          <Tabs tabs={TABS} activeId={tab} onChange={handleTabChange} ariaLabel="Feed type" />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            title="Sign in for your Following feed"
            description="Follow creators and their newest videos will appear here."
            actionLabel="Log in"
            onAction={() => router.push("/login?next=/home?tab=following")}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-64px)] flex-col bg-black md:h-dvh">
      <div className="flex justify-center border-b border-white/10 bg-black py-2.5">
        <Tabs tabs={TABS} activeId={tab} onChange={handleTabChange} ariaLabel="Feed type" />
      </div>
      <div className="min-h-0 flex-1">
        <Feed
          fetchPage={fetchPage}
          feedKey={tab}
          onOpenComments={setCommentsVideo}
          onShare={setShareVideo}
          emptyTitle={
            tab === "following"
              ? "No videos from people you follow yet"
              : tab === "latest"
                ? "No videos yet"
                : "Nothing on For You yet"
          }
          emptyDescription={
            tab === "following"
              ? "Follow some creators from Explore to fill this feed."
              : "Be the first to post — tap Create to share a video."
          }
        />
      </div>

      <CommentsSheet
        video={commentsVideo}
        onClose={() => setCommentsVideo(null)}
        onCountChange={handleCommentCount}
      />
      <ShareDialog video={shareVideo} onClose={() => setShareVideo(null)} />
      {tab === "foryou" && !user && <GuestBanner />}
    </div>
  );
}

function GuestBanner() {
  const router = useRouter();
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-black px-4 py-3">
      <p className="text-sm text-white/70">Log in to like, comment, and follow creators.</p>
      <Button size="sm" onClick={() => router.push("/login?next=/home")}>
        Log in
      </Button>
    </div>
  );
}
