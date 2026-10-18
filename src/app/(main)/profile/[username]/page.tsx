"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { ProfileWithCounts, VideoWithDetails } from "@/lib/db";
import { apiRequest, errorMessage, ApiClientError } from "@/lib/api-client";
import { avatarUrl } from "@/lib/media";
import { compactCount } from "@/lib/format";
import { useAuth, loginRedirect } from "@/hooks/useAuth";
import { useToast } from "@/components/ui/Toast";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Dialog } from "@/components/ui/Dialog";
import { ProfileEditor } from "@/components/ProfileEditor";
import { ReportDialog } from "@/components/ReportDialog";
import { VideoGrid } from "@/components/VideoGrid";

interface FollowListUser {
  id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  verified: boolean;
}

/**
 * Public profile: header (avatar, name, bio, real counts), Follow/Unfollow,
 * Message (find-or-create conversation, then /inbox?conversation=<id>),
 * video grid, Edit profile for the owner, followers/following dialogs,
 * and report-user action.
 */
export default function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  const router = useRouter();
  const { user, loading: authLoading, refreshProfile } = useAuth();
  const { toast } = useToast();
  const supabase = useMemo(() => createClient(), []);

  const [profile, setProfile] = useState<ProfileWithCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [messageBusy, setMessageBusy] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [listDialog, setListDialog] = useState<"followers" | "following" | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const isOwner = user !== null && profile !== null && user.id === profile.id;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const data = await apiRequest<{ profile: ProfileWithCounts }>(
        `/api/users/${encodeURIComponent(username)}`
      );
      setProfile(data.profile);
      setFollowing(data.profile.is_followed_by_viewer === true);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 404) {
        setNotFound(true);
      } else {
        setError(errorMessage(e, "Could not load profile"));
      }
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleFollow = useCallback(async () => {
    if (!profile) return;
    if (!user) {
      router.push(loginRedirect(`/profile/${username}`));
      return;
    }
    setFollowBusy(true);
    try {
      if (following) {
        const data = await apiRequest<{ following: boolean; follower_count: number }>(
          `/api/follows?user_id=${encodeURIComponent(profile.id)}`,
          { method: "DELETE" }
        );
        setFollowing(false);
        setProfile((p) => (p ? { ...p, follower_count: data.follower_count } : p));
      } else {
        const data = await apiRequest<{ following: boolean; follower_count: number }>(
          "/api/follows",
          { method: "POST", json: { user_id: profile.id } }
        );
        setFollowing(true);
        setProfile((p) => (p ? { ...p, follower_count: data.follower_count } : p));
        toast(`Following @${profile.username}`, "success");
      }
    } catch (e) {
      toast(errorMessage(e, "Could not update follow"), "error");
    } finally {
      setFollowBusy(false);
    }
  }, [profile, following, user, router, username, toast]);

  const startConversation = useCallback(async () => {
    if (!profile) return;
    if (!user) {
      router.push(loginRedirect(`/profile/${username}`));
      return;
    }
    setMessageBusy(true);
    try {
      const data = await apiRequest<{ conversation: { id: string } }>("/api/conversations", {
        method: "POST",
        json: { user_id: profile.id },
      });
      router.push(`/inbox?conversation=${encodeURIComponent(data.conversation.id)}`);
    } catch (e) {
      toast(errorMessage(e, "Could not start conversation"), "error");
    } finally {
      setMessageBusy(false);
    }
  }, [profile, user, router, username, toast]);

  const handleSaved = useCallback(
    (updated: ProfileWithCounts) => {
      setProfile(updated);
      if (updated.username !== username) {
        router.replace(`/profile/${updated.username}`);
      }
      void refreshProfile();
    },
    [username, router, refreshProfile]
  );

  if (loading || authLoading) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 py-10">
        <Spinner size="lg" label="Loading profile" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex min-h-[60dvh] items-center justify-center px-4">
        <EmptyState
          title="User not found"
          description="This profile doesn't exist, is private, or isn't available to you."
          actionLabel="Go home"
          onAction={() => router.push("/home")}
        />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-ink-muted">{error ?? "Could not load profile"}</p>
        <Button variant="secondary" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-4">
          <Avatar src={avatarUrl(supabase, profile.avatar_path)} name={profile.username} size="xl" />
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-black text-ink">
              <span className="truncate">{profile.display_name ?? `@${profile.username}`}</span>
              {profile.verified && (
                <svg className="h-5 w-5 shrink-0 fill-[var(--color-brand-blue)]" viewBox="0 0 24 24" aria-label="Verified">
                  <path d="M12 2l2.4 2.4 3.4-.5.9 3.3 3.1 1.5-1.5 3.1 1.5 3.1-3.1 1.5-.9 3.3-3.4-.5L12 22l-2.4-2.4-3.4.5-.9-3.3-3.1-1.5L3.7 12 2.2 8.9l3.1-1.5.9-3.3 3.4.5L12 2zm-1.2 13.6l5-5-1.4-1.4-3.6 3.6-1.6-1.6-1.4 1.4 3 3z" />
                </svg>
              )}
            </h1>
            <p className="text-sm text-ink-muted">@{profile.username}</p>
            {profile.is_private && (
              <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-surface-elevated px-2 py-0.5 text-xs text-ink-muted">
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="4" y="11" width="16" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 018 0v4" />
                </svg>
                Private
              </p>
            )}
          </div>
          {!isOwner && user && (
            <button
              type="button"
              onClick={() => setReportOpen(true)}
              aria-label={`Report @${profile.username}`}
              className="rounded-lg p-2 text-ink-muted hover:bg-surface-elevated hover:text-ink"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </button>
          )}
        </div>

        {profile.bio && <p className="whitespace-pre-wrap text-sm text-ink">{profile.bio}</p>}
        {profile.website_url && (
          <a
            href={profile.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-sm font-medium text-[var(--color-brand-blue)] hover:underline"
          >
            {profile.website_url.replace(/^https?:\/\//i, "")}
          </a>
        )}

        {/* Counts */}
        <div className="flex gap-6 text-sm">
          <button
            type="button"
            onClick={() => setListDialog("followers")}
            className="hover:underline"
            aria-label={`View ${profile.follower_count} followers`}
          >
            <span className="font-bold text-ink">{compactCount(profile.follower_count)}</span>{" "}
            <span className="text-ink-muted">Followers</span>
          </button>
          <button
            type="button"
            onClick={() => setListDialog("following")}
            className="hover:underline"
            aria-label={`View ${profile.following_count} following`}
          >
            <span className="font-bold text-ink">{compactCount(profile.following_count)}</span>{" "}
            <span className="text-ink-muted">Following</span>
          </button>
          <span>
            <span className="font-bold text-ink">{compactCount(profile.video_count)}</span>{" "}
            <span className="text-ink-muted">Videos</span>
          </span>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          {isOwner ? (
            <>
              <Button variant="secondary" onClick={() => setEditorOpen(true)} className="flex-1">
                Edit profile
              </Button>
              <Link
                href="/inbox"
                className="flex flex-1 items-center justify-center rounded-xl border border-border bg-surface-elevated px-4 py-2.5 font-semibold text-ink hover:border-[var(--color-brand-blue)]"
              >
                Inbox
              </Link>
            </>
          ) : (
            <>
              <Button
                onClick={() => void toggleFollow()}
                loading={followBusy}
                variant={following ? "secondary" : "primary"}
                className="flex-1"
              >
                {following ? "Following" : "Follow"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void startConversation()}
                loading={messageBusy}
                className="flex-1"
              >
                Message
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Videos */}
      <div className="mt-8">
        <h2 className="mb-3 text-lg font-bold text-ink">Videos</h2>
        <ProfileVideos username={profile.username} supabase={supabase} />
      </div>

      {isOwner && (
        <ProfileEditor
          profile={profile}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          onSaved={handleSaved}
        />
      )}

      <FollowListDialog
        username={profile.username}
        kind={listDialog}
        onClose={() => setListDialog(null)}
        supabase={supabase}
      />

      <ReportDialog
        targetType="user"
        targetId={profile.id}
        open={reportOpen}
        onClose={() => setReportOpen(false)}
      />
    </div>
  );
}

function ProfileVideos({
  username,
  supabase,
}: {
  username: string;
  supabase: ReturnType<typeof createClient>;
}) {
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
        const data = await apiRequest<{ videos: VideoWithDetails[]; next_cursor: string | null }>(
          `/api/users/${encodeURIComponent(username)}/videos${params}`
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
        setError(errorMessage(e, "Could not load videos"));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [username]
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-1" aria-label="Loading videos">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-[3/4] animate-pulse rounded-lg bg-surface-elevated" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-ink-muted">{error}</p>
        <Button variant="secondary" size="sm" onClick={() => { setLoading(true); void load(null, false); }}>
          Retry
        </Button>
      </div>
    );
  }
  if (videos.length === 0) {
    return <EmptyState title="No videos yet" description="Videos posted by this account will appear here." />;
  }
  return (
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
  );
}

function FollowListDialog({
  username,
  kind,
  onClose,
  supabase,
}: {
  username: string;
  kind: "followers" | "following" | null;
  onClose: () => void;
  supabase: ReturnType<typeof createClient>;
}) {
  const { user } = useAuth();
  const [items, setItems] = useState<FollowListUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursorToUse: string | null, append: boolean) => {
      if (!kind) return;
      setLoading(true);
      try {
        const params = cursorToUse ? `?cursor=${encodeURIComponent(cursorToUse)}` : "";
        const data = await apiRequest<{ followers?: FollowListUser[]; following?: FollowListUser[]; next_cursor: string | null }>(
          `/api/users/${encodeURIComponent(username)}/${kind}${params}`
        );
        const list = kind === "followers" ? (data.followers ?? []) : (data.following ?? []);
        setItems((prev) => {
          const merged = append ? [...prev, ...list] : list;
          const seen = new Set<string>();
          return merged.filter((u) => {
            if (seen.has(u.id)) return false;
            seen.add(u.id);
            return true;
          });
        });
        setCursor(data.next_cursor);
        setHasMore(data.next_cursor !== null);
        setError(null);
      } catch (e) {
        setError(errorMessage(e, "Could not load list"));
      } finally {
        setLoading(false);
      }
    },
    [username, kind]
  );

  useEffect(() => {
    if (kind) {
      setItems([]);
      setCursor(null);
      setHasMore(true);
      void load(null, false);
    }
  }, [kind, load]);

  return (
    <Dialog
      open={kind !== null}
      onClose={onClose}
      title={kind === "followers" ? "Followers" : "Following"}
    >
      {!user ? (
        <EmptyState
          title="Sign in to see this list"
          description="Follower lists are only visible to signed-in users."
        />
      ) : loading && items.length === 0 ? (
        <div className="flex justify-center py-8">
          <Spinner label="Loading list" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-sm text-ink-muted">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void load(null, false)}>
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="Nobody here yet" />
      ) : (
        <>
          <ul className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto">
            {items.map((u) => (
              <li key={u.id}>
                <Link
                  href={`/profile/${u.username}`}
                  onClick={onClose}
                  className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface"
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
          {hasMore && (
            <div className="mt-3 flex justify-center">
              <Button variant="ghost" size="sm" loading={loading} onClick={() => void load(cursor, true)}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
