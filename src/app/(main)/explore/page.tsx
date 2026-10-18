"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { VideoWithDetails } from "@/lib/db";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { avatarUrl } from "@/lib/media";
import { extractHashtags } from "@/lib/validation";
import { useDebounce } from "@/hooks/useDebounce";
import { Input } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { Avatar } from "@/components/ui/Avatar";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { VideoGrid } from "@/components/VideoGrid";

type SearchType = "videos" | "users" | "hashtags";

interface SearchUser {
  id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  verified: boolean;
}

const SEARCH_TABS: { id: SearchType; label: string }[] = [
  { id: "videos", label: "Videos" },
  { id: "users", label: "Users" },
  { id: "hashtags", label: "Hashtags" },
];

/**
 * Explore: debounced search (GET /api/search?q=&type=), trending hashtags
 * and recommended creators derived from recent real videos, and a recent
 * videos grid.
 */
export default function ExplorePage() {
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query.trim(), 350);
  const [searchType, setSearchType] = useState<SearchType>("videos");

  const [videos, setVideos] = useState<VideoWithDetails[]>([]);
  const [users, setUsers] = useState<SearchUser[]>([]);
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const isSearching = debouncedQuery.length >= 2;

  useEffect(() => {
    if (!isSearching) {
      setVideos([]);
      setUsers([]);
      setHashtags([]);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    apiRequest<{ videos?: VideoWithDetails[]; users?: SearchUser[]; hashtags?: string[] }>(
      `/api/search?q=${encodeURIComponent(debouncedQuery)}&type=${searchType}`
    )
      .then((data) => {
        if (cancelled) return;
        setVideos(data.videos ?? []);
        setUsers(data.users ?? []);
        setHashtags(data.hashtags ?? []);
      })
      .catch((e) => {
        if (!cancelled) setSearchError(errorMessage(e, "Search failed"));
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, searchType, isSearching]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-2xl font-black text-ink">Explore</h1>

      <div className="mt-4 flex flex-col gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search videos, users, #hashtags"
          aria-label="Search VYRO"
          autoComplete="off"
        />
        {isSearching && (
          <Tabs
            tabs={SEARCH_TABS}
            activeId={searchType}
            onChange={setSearchType}
            ariaLabel="Search type"
          />
        )}
      </div>

      {isSearching ? (
        <SearchResults
          type={searchType}
          videos={videos}
          users={users}
          hashtags={hashtags}
          searching={searching}
          error={searchError}
          supabase={supabase}
        />
      ) : (
        <Discovery supabase={supabase} />
      )}
    </div>
  );
}

function SearchResults({
  type,
  videos,
  users,
  hashtags,
  searching,
  error,
  supabase,
}: {
  type: SearchType;
  videos: VideoWithDetails[];
  users: SearchUser[];
  hashtags: string[];
  searching: boolean;
  error: string | null;
  supabase: ReturnType<typeof createClient>;
}) {
  if (searching && videos.length === 0 && users.length === 0 && hashtags.length === 0) {
    return (
      <div className="grid grid-cols-3 gap-2 py-6" aria-label="Loading results">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[3/4]" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-ink-muted">{error}</p>
      </div>
    );
  }
  if (type === "videos") {
    if (videos.length === 0)
      return <EmptyState title="No videos found" description="Try a different search term." />;
    return <VideoGrid videos={videos} supabase={supabase} />;
  }
  if (type === "users") {
    if (users.length === 0)
      return <EmptyState title="No users found" description="Try a different search term." />;
    return (
      <ul className="mt-4 flex flex-col gap-1">
        {users.map((u) => (
          <li key={u.id}>
            <Link
              href={`/profile/${u.username}`}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-elevated"
            >
              <Avatar src={avatarUrl(supabase, u.avatar_path)} name={u.username} />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink">
                  {u.display_name ?? `@${u.username}`}
                </p>
                <p className="truncate text-xs text-ink-muted">@{u.username}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  if (hashtags.length === 0)
    return <EmptyState title="No hashtags found" description="Try a different search term." />;
  return (
    <ul className="mt-4 flex flex-wrap gap-2">
      {hashtags.map((tag) => (
        <li key={tag}>
          <Link
            href={`/hashtag/${tag}`}
            className="block rounded-full border border-border bg-surface-elevated px-4 py-2 text-sm font-semibold text-[var(--color-brand-blue)] hover:border-[var(--color-brand-blue)]"
          >
            #{tag}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Discovery sections when no search is active. Trending hashtags and
 * recommended creators are computed from the latest real videos
 * (hashtags parsed from captions; creators deduped by id).
 */
function Discovery({ supabase }: { supabase: ReturnType<typeof createClient> }) {
  const [latest, setLatest] = useState<VideoWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ videos: VideoWithDetails[] }>("/api/feed?type=latest&limit=30")
      .then((data) => {
        if (!cancelled) setLatest(data.videos);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e, "Could not load Explore"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trendingTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of latest) {
      for (const tag of extractHashtags(v.caption)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag]) => tag);
  }, [latest]);

  const creators = useMemo(() => {
    const seen = new Map<string, VideoWithDetails["creator"]>();
    for (const v of latest) {
      if (!seen.has(v.creator.id)) seen.set(v.creator.id, v.creator);
      if (seen.size >= 8) break;
    }
    return [...seen.values()];
  }, [latest]);

  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-2 py-6" aria-label="Loading Explore">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[3/4]" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-ink-muted">{error}</p>
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-8">
      {trendingTags.length > 0 && (
        <section aria-labelledby="trending-heading">
          <h2 id="trending-heading" className="mb-3 text-lg font-bold text-ink">
            Trending hashtags
          </h2>
          <ul className="flex flex-wrap gap-2">
            {trendingTags.map((tag) => (
              <li key={tag}>
                <Link
                  href={`/hashtag/${tag}`}
                  className="block rounded-full border border-border bg-surface-elevated px-4 py-2 text-sm font-semibold text-[var(--color-brand-blue)] hover:border-[var(--color-brand-blue)]"
                >
                  #{tag}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {creators.length > 0 && (
        <section aria-labelledby="creators-heading">
          <h2 id="creators-heading" className="mb-3 text-lg font-bold text-ink">
            Creators to watch
          </h2>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {creators.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/profile/${c.username}`}
                  className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface-elevated p-4 hover:border-[var(--color-brand-blue)]"
                >
                  <Avatar src={avatarUrl(supabase, c.avatar_path)} name={c.username} size="lg" />
                  <div className="min-w-0 text-center">
                    <p className="truncate text-sm font-bold text-ink">
                      {c.display_name ?? `@${c.username}`}
                    </p>
                    <p className="truncate text-xs text-ink-muted">@{c.username}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="mb-3 text-lg font-bold text-ink">
          Recent videos
        </h2>
        {latest.length === 0 ? (
          <EmptyState title="No videos yet" description="Check back soon — or be the first to post." />
        ) : (
          <VideoGrid videos={latest} supabase={supabase} />
        )}
      </section>
    </div>
  );
}
