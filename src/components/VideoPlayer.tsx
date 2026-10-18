"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { resolveVideoUrl, thumbnailUrl, VideoUrlError } from "@/lib/media";
import { useIntersection } from "@/hooks/useIntersection";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Video player for VYRO.
 *
 * Props:
 *   videoId: id of the video row (required). The playable URL is resolved
 *     via GET /api/videos/[id]/stream, which enforces the same visibility
 *     rule as the video detail API -- public videos play for any viewer,
 *     including logged-out users; anything not viewable shows an honest
 *     error state.
 *   thumbnailPath: thumbnails-bucket path used as poster (optional).
 *   active: only plays while visible AND active (feeds pass "is this the
 *     focused card"); default false so standalone players don't autoplay.
 *   loop: loop playback (default true for feeds).
 *   className: applied to the wrapping element (sizing is the caller's job).
 *
 * Behavior:
 * - Resolves a playable URL via resolveVideoUrl (server-minted signed URL).
 * - IntersectionObserver pauses when scrolled out of view; resumes when
 *   visible again (if it was playing).
 * - Muted by default with an unmute control; tap toggles play/pause.
 * - Clickable progress bar for seeking; playback-error state with retry.
 */
export function VideoPlayer({
  videoId,
  thumbnailPath,
  active = false,
  loop = true,
  className = "",
}: {
  videoId: string;
  thumbnailPath?: string | null;
  active?: boolean;
  loop?: boolean;
  className?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [wrapRef, isVisible] = useIntersection<HTMLDivElement>({ threshold: 0.55 });

  const [src, setSrc] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [playError, setPlayError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [resolving, setResolving] = useState(true);
  const userPausedRef = useRef(false);

  const poster = useMemo(
    () => thumbnailUrl(supabase, thumbnailPath),
    [supabase, thumbnailPath]
  );

  // Resolve the playable URL once per video.
  useEffect(() => {
    let cancelled = false;
    setResolving(true);
    setResolveError(null);
    resolveVideoUrl(videoId)
      .then((url) => {
        if (!cancelled) {
          setSrc(url);
          setResolving(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setResolveError(
            e instanceof VideoUrlError ? e.message : "Video could not be loaded"
          );
          setResolving(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // Autoplay / pause with visibility + active flag.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (isVisible && active && !userPausedRef.current && !playError) {
      video.play().catch(() => {
        /* autoplay blocked: user can tap to play */
      });
    } else if (!isVisible || !active) {
      video.pause();
    }
  }, [isVisible, active, src, playError]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      userPausedRef.current = false;
      video.play().catch(() => setPlayError(true));
    } else {
      userPausedRef.current = true;
      video.pause();
    }
  }, []);

  const toggleMute = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMuted((m) => {
      const next = !m;
      if (videoRef.current) videoRef.current.muted = next;
      return next;
    });
  }, []);

  const seek = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const bar = progressRef.current;
    const video = videoRef.current;
    if (!bar || !video || !Number.isFinite(video.duration)) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
  }, []);

  const retry = useCallback(() => {
    setPlayError(false);
    setResolveError(null);
    const video = videoRef.current;
    if (video && src) {
      video.load();
      video.play().catch(() => {});
    }
  }, [src]);

  return (
    <div
      ref={wrapRef}
      className={`relative overflow-hidden bg-black ${className}`}
      onClick={togglePlay}
      role="button"
      aria-label={playing ? "Pause video" : "Play video"}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          togglePlay();
        }
      }}
    >
      {resolving && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner label="Loading video" />
        </div>
      )}

      {(resolveError || playError) && !resolving && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
          <svg className="h-10 w-10 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
          </svg>
          <p className="text-sm text-white">
            {resolveError ?? "This video cannot be played right now"}
          </p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              retry();
            }}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
          >
            Retry
          </button>
        </div>
      )}

      {src && !resolveError && (
        <video
          ref={videoRef}
          src={src}
          poster={poster ?? undefined}
          loop={loop}
          muted={muted}
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setProgress(v.duration ? v.currentTime / v.duration : 0);
          }}
          onError={() => setPlayError(true)}
        />
      )}

      {/* Center play indicator when paused (not on error). */}
      {!playing && src && !resolveError && !playError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/50">
            <svg className="h-8 w-8 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Mute control */}
      {src && !resolveError && (
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute video" : "Mute video"}
          aria-pressed={!muted}
          className="absolute right-3 top-3 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
        >
          {muted ? (
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
            </svg>
          ) : (
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          )}
        </button>
      )}

      {/* Progress bar */}
      {src && !resolveError && (
        <div
          ref={progressRef}
          role="slider"
          aria-label="Video progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          tabIndex={0}
          onClick={seek}
          onKeyDown={(e) => {
            const video = videoRef.current;
            if (!video || !Number.isFinite(video.duration)) return;
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.stopPropagation();
              e.preventDefault();
              video.currentTime = Math.min(
                video.duration,
                Math.max(0, video.currentTime + (e.key === "ArrowRight" ? 5 : -5))
              );
            }
          }}
          className="absolute inset-x-0 bottom-0 h-6 cursor-pointer"
        >
          <div className="absolute inset-x-0 bottom-1.5 h-1 bg-white/25">
            <div className="h-full bg-white transition-[width]" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
