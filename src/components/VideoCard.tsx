"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { VideoWithDetails } from "@/lib/db";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { avatarUrl } from "@/lib/media";
import { compactCount, timeAgo } from "@/lib/format";
import { useAuth, loginRedirect } from "@/hooks/useAuth";
import { useToast } from "@/components/ui/Toast";
import { Avatar } from "@/components/ui/Avatar";
import { VideoPlayer } from "@/components/VideoPlayer";
import { useRouter } from "next/navigation";

/**
 * One feed card: video player, right action rail (like, comments, share,
 * follow), and bottom caption with creator info and hashtag links.
 *
 * Props:
 *   video: enriched video row from the API.
 *   active: true when this is the focused card (controls autoplay).
 *   onOpenComments(video): opens the comments sheet.
 *   onShare(video): opens the share dialog.
 *
 * Likes update optimistically and roll back on failure. Protected actions
 * (like, follow) redirect anonymous users to /login?next=<current path>.
 */

const HASHTAG_RE = /#([A-Za-z0-9_]{1,64})/g;

function CaptionText({ caption }: { caption: string }) {
  const parts = useMemo(() => {
    const out: { text: string; tag: string | null }[] = [];
    let last = 0;
    for (const match of caption.matchAll(HASHTAG_RE)) {
      const idx = match.index ?? 0;
      if (idx > last) out.push({ text: caption.slice(last, idx), tag: null });
      const tag = (match[1] ?? "").toLowerCase();
      out.push({ text: match[0] ?? "", tag });
      last = idx + (match[0]?.length ?? 0);
    }
    if (last < caption.length) out.push({ text: caption.slice(last), tag: null });
    return out;
  }, [caption]);

  return (
    <p className="text-sm text-white">
      {parts.map((part, i) =>
        part.tag ? (
          <Link
            key={i}
            href={`/hashtag/${part.tag}`}
            onClick={(e) => e.stopPropagation()}
            className="font-semibold text-[var(--color-brand-blue)] hover:underline"
          >
            {part.text}
          </Link>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </p>
  );
}

function ActionButton({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      aria-pressed={pressed}
      className="flex flex-col items-center gap-1 text-white"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/40 transition-transform active:scale-90">
        {children}
      </span>
    </button>
  );
}

export function VideoCard({
  video,
  active = false,
  onOpenComments,
  onShare,
}: {
  video: VideoWithDetails;
  active?: boolean;
  onOpenComments: (video: VideoWithDetails) => void;
  onShare: (video: VideoWithDetails) => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [liked, setLiked] = useState(video.liked_by_viewer ?? false);
  const [likeCount, setLikeCount] = useState(video.like_count);
  const [likeBusy, setLikeBusy] = useState(false);
  const [following, setFollowing] = useState<boolean | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  useEffect(() => {
    setLiked(video.liked_by_viewer ?? false);
    setLikeCount(video.like_count);
  }, [video.id, video.liked_by_viewer, video.like_count]);

  const requireLogin = useCallback((): boolean => {
    if (!user) {
      router.push(loginRedirect(window.location.pathname));
      return false;
    }
    return true;
  }, [user, router]);

  const toggleLike = useCallback(async () => {
    if (!requireLogin() || likeBusy) return;
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
  }, [requireLogin, likeBusy, liked, video.id, toast]);

  const toggleFollow = useCallback(async () => {
    if (!requireLogin() || followBusy) return;
    setFollowBusy(true);
    const targetId = video.creator.id;
    try {
      if (following) {
        await apiRequest(`/api/follows?user_id=${encodeURIComponent(targetId)}`, {
          method: "DELETE",
        });
        setFollowing(false);
      } else {
        await apiRequest("/api/follows", { method: "POST", json: { user_id: targetId } });
        setFollowing(true);
        toast(`Following @${video.creator.username}`, "success");
      }
    } catch (e) {
      toast(errorMessage(e, "Could not update follow"), "error");
    } finally {
      setFollowBusy(false);
    }
  }, [requireLogin, followBusy, following, video.creator.id, video.creator.username, toast]);

  // Seed "following" from the creator's profile when we can; the feed's
  // enrich payload does not carry it, so fetch lazily only when needed.
  useEffect(() => {
    if (!user || user.id === video.creator.id || following !== null) return;
    let cancelled = false;
    fetch(`/api/users/${encodeURIComponent(video.creator.username)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.profile) {
          setFollowing(data.profile.is_followed_by_viewer === true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, video.creator.id, video.creator.username, following]);

  const creatorAvatar = avatarUrl(supabase, video.creator.avatar_path);
  const isOwnVideo = user?.id === video.creator.id;

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <VideoPlayer
        videoId={video.id}
        thumbnailPath={video.thumbnail_path}
        active={active}
        className="h-full w-full"
      />

      {/* Right action rail */}
      <div className="absolute bottom-24 right-3 flex flex-col items-center gap-4">
        {!isOwnVideo && user && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void toggleFollow();
            }}
            disabled={followBusy}
            aria-label={following ? `Unfollow @${video.creator.username}` : `Follow @${video.creator.username}`}
            aria-pressed={following === true}
            className="relative"
          >
            <Avatar src={creatorAvatar} name={video.creator.username} size="md" />
            <span
              className={`absolute -bottom-2 left-1/2 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full text-xs font-bold text-white ${
                following ? "bg-ink-muted" : "bg-[var(--color-brand-blue)]"
              }`}
              aria-hidden="true"
            >
              {following ? (
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                </svg>
              )}
            </span>
          </button>
        )}

        <div className="flex flex-col items-center">
          <ActionButton label={liked ? "Unlike" : "Like"} pressed={liked} onClick={() => void toggleLike()}>
            <svg
              className={`h-7 w-7 ${liked ? "fill-red-500 text-red-500" : "text-white"}`}
              viewBox="0 0 24 24"
              fill={liked ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </ActionButton>
          <span className="text-xs font-semibold text-white">{compactCount(likeCount)}</span>
        </div>

        <div className="flex flex-col items-center">
          <ActionButton label="Open comments" onClick={() => onOpenComments(video)}>
            <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-3.74-.74L3 20l1.34-4.02A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </ActionButton>
          <span className="text-xs font-semibold text-white">{compactCount(video.comment_count)}</span>
        </div>

        <div className="flex flex-col items-center">
          <ActionButton label="Share video" onClick={() => onShare(video)}>
            <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </ActionButton>
          <span className="text-xs font-semibold text-white">Share</span>
        </div>
      </div>

      {/* Bottom caption / creator */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-6 pt-12">
        <Link
          href={`/profile/${video.creator.username}`}
          onClick={(e) => e.stopPropagation()}
          className="mb-2 flex items-center gap-2"
        >
          <Avatar src={creatorAvatar} name={video.creator.username} size="sm" />
          <span className="text-sm font-bold text-white hover:underline">
            @{video.creator.username}
          </span>
          {video.creator.verified && (
            <svg className="h-4 w-4 fill-[var(--color-brand-blue)]" viewBox="0 0 24 24" aria-label="Verified">
              <path d="M12 2l2.4 2.4 3.4-.5.9 3.3 3.1 1.5-1.5 3.1 1.5 3.1-3.1 1.5-.9 3.3-3.4-.5L12 22l-2.4-2.4-3.4.5-.9-3.3-3.1-1.5L3.7 12 2.2 8.9l3.1-1.5.9-3.3 3.4.5L12 2zm-1.2 13.6l5-5-1.4-1.4-3.6 3.6-1.6-1.6-1.4 1.4 3 3z" />
            </svg>
          )}
          <span className="text-xs text-white/60">{timeAgo(video.created_at)}</span>
        </Link>
        {video.caption && <CaptionText caption={video.caption} />}
      </div>
    </div>
  );
}
