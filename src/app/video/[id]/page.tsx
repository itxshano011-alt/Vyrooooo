"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { VideoWithDetails } from "@/lib/db";
import { apiRequest, errorMessage, ApiClientError } from "@/lib/api-client";
import { avatarUrl } from "@/lib/media";
import { compactCount, timeAgo } from "@/lib/format";
import { extractHashtags } from "@/lib/validation";
import { useAuth, loginRedirect } from "@/hooks/useAuth";
import { useToast } from "@/components/ui/Toast";
import { config } from "@/lib/config";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { VideoPlayer } from "@/components/VideoPlayer";
import { CommentsSheet } from "@/components/CommentsSheet";
import { ShareDialog } from "@/components/ShareDialog";
import { ReportDialog } from "@/components/ReportDialog";

/**
 * Stable public video URL: /video/[id].
 * Big player, caption with linked hashtags, like/comment/share actions,
 * creator info. A video the viewer cannot see (private / removed / missing)
 * renders a locked state — the API returns 404 for all of these, so the
 * message covers every case honestly.
 */
export default function VideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();
  const supabase = useMemo(() => createClient(), []);

  const [video, setVideo] = useState<VideoWithDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  const [likeBusy, setLikeBusy] = useState(false);

  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLocked(false);
    setError(null);
    try {
      const data = await apiRequest<{ video: VideoWithDetails }>(`/api/videos/${id}`);
      setVideo(data.video);
      setLiked(data.video.liked_by_viewer ?? false);
      setLikeCount(data.video.like_count);
      setCommentCount(data.video.comment_count);
    } catch (e) {
      if (e instanceof ApiClientError && (e.status === 404 || e.status === 403)) {
        setLocked(true);
      } else {
        setError(errorMessage(e, "Could not load video"));
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleLike = useCallback(async () => {
    if (!video) return;
    if (!user) {
      router.push(loginRedirect(`/video/${video.id}`));
      return;
    }
    if (likeBusy) return;
    setLikeBusy(true);
    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount((c) => c + (wasLiked ? -1 : 1));
    try {
      const data = await apiRequest<{ liked: boolean; like_count: number }>(
        `/api/videos/${video.id}/like`,
        { method: wasLiked ? "DELETE" : "POST" }
      );
      setLiked(data.liked);
      setLikeCount(data.like_count);
    } catch (e) {
      setLiked(wasLiked);
      setLikeCount((c) => c + (wasLiked ? 1 : -1));
      toast(errorMessage(e, "Could not update like"), "error");
    } finally {
      setLikeBusy(false);
    }
  }, [video, user, router, likeBusy, liked, toast]);

  const tags = useMemo(() => extractHashtags(video?.caption), [video?.caption]);

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-black">
        <Spinner size="lg" label="Loading video" />
      </main>
    );
  }

  if (locked) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface px-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-elevated">
          <svg className="h-8 w-8 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 018 0v4" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-ink">This video is unavailable</h1>
        <p className="max-w-sm text-sm text-ink-muted">
          It may be private, removed, or the link might be wrong. If you own
          this video, log in to watch it.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => router.push("/home")}>
            Go home
          </Button>
          {!user && <Button onClick={() => router.push(loginRedirect(`/video/${id}`))}>Log in</Button>}
        </div>
      </main>
    );
  }

  if (error || !video) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface px-6 text-center">
        <p className="text-ink-muted">{error ?? "Could not load video"}</p>
        <Button variant="secondary" onClick={() => void load()}>
          Retry
        </Button>
      </main>
    );
  }

  const isOwner = user?.id === video.creator_id;

  return (
    <main className="min-h-dvh bg-surface text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <Link
          href="/home"
          className="bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] bg-clip-text text-xl font-black text-transparent"
        >
          {config.siteName}
        </Link>
        <div className="flex gap-2">
          {!user ? (
            <Button size="sm" onClick={() => router.push(loginRedirect(`/video/${id}`))}>
              Log in
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => router.push("/home")}>
              Open app
            </Button>
          )}
        </div>
      </header>

      <div className="mx-auto grid max-w-5xl gap-6 px-4 pb-16 md:grid-cols-[minmax(0,1fr)_320px]">
        {/* Player */}
        <div className="overflow-hidden rounded-2xl bg-black">
          <VideoPlayer
            videoId={video.id}
            thumbnailPath={video.thumbnail_path}
            active
            className="aspect-[9/16] max-h-[80dvh] w-full"
          />
        </div>

        {/* Details */}
        <div className="flex flex-col gap-4">
          <Link href={`/profile/${video.creator.username}`} className="flex items-center gap-3">
            <Avatar src={avatarUrl(supabase, video.creator.avatar_path)} name={video.creator.username} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-bold text-ink hover:underline">
                {video.creator.display_name ?? `@${video.creator.username}`}
              </p>
              <p className="truncate text-sm text-ink-muted">
                @{video.creator.username} · {timeAgo(video.created_at)}
              </p>
            </div>
          </Link>

          {video.caption && <p className="whitespace-pre-wrap text-sm text-ink">{video.caption}</p>}

          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Hashtags">
              {tags.map((tag) => (
                <Link
                  key={tag}
                  href={`/hashtag/${tag}`}
                  className="rounded-full border border-border bg-surface-elevated px-3 py-1 text-sm font-semibold text-[var(--color-brand-blue)] hover:border-[var(--color-brand-blue)]"
                >
                  #{tag}
                </Link>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant={liked ? "primary" : "secondary"}
              size="sm"
              onClick={() => void toggleLike()}
              aria-pressed={liked}
            >
              <svg className={`h-4 w-4 ${liked ? "fill-current" : ""}`} viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              {compactCount(likeCount)}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setCommentsOpen(true)}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-3.74-.74L3 20l1.34-4.02A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              {compactCount(commentCount)}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)}>
              Share
            </Button>
            {!isOwner && (
              <Button variant="ghost" size="sm" onClick={() => setReportOpen(true)}>
                Report
              </Button>
            )}
          </div>

          {isOwner && video.visibility === "private" && (
            <p className="rounded-xl border border-border bg-surface-elevated p-3 text-xs text-ink-muted">
              Only you can see this video — it&apos;s set to private.
            </p>
          )}
        </div>
      </div>

      <CommentsSheet
        video={commentsOpen ? video : null}
        onClose={() => setCommentsOpen(false)}
        onCountChange={(_vid, delta) => setCommentCount((c) => Math.max(0, c + delta))}
      />
      <ShareDialog video={shareOpen ? video : null} onClose={() => setShareOpen(false)} />
      <ReportDialog
        targetType="video"
        targetId={video.id}
        open={reportOpen}
        onClose={() => setReportOpen(false)}
      />
    </main>
  );
}
