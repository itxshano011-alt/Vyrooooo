"use client";

import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { VideoWithDetails } from "@/lib/db";
import { thumbnailUrl } from "@/lib/media";
import { compactCount } from "@/lib/format";

/** Shared 3-column thumbnail grid linking to /video/[id]. Exported for hashtag page reuse. */
export function VideoGrid({
  videos,
  supabase,
}: {
  videos: VideoWithDetails[];
  supabase: ReturnType<typeof createClient>;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 sm:gap-2">
      {videos.map((v) => {
        const poster = thumbnailUrl(supabase, v.thumbnail_path);
        return (
          <Link
            key={v.id}
            href={`/video/${v.id}`}
            className="group relative aspect-[3/4] overflow-hidden rounded-lg bg-surface-elevated"
            aria-label={`Video by @${v.creator.username}`}
          >
            {poster ? (
              <img
                src={poster}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <svg className="h-8 w-8 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.55-2.28A1 1 0 0121 8.62v6.76a1 1 0 01-1.45.9L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
            )}
            <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">
              <svg className="h-3 w-3 fill-red-500" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              {compactCount(v.like_count)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
