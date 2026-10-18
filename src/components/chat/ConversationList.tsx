"use client";

import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { timeAgo } from "@/lib/format";
import type { ConversationWithPreview } from "@/lib/db";
import { avatarUrl } from "./urls";

interface ConversationListProps {
  conversations: ConversationWithPreview[];
  viewerId: string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  query: string;
  onQueryChange: (query: string) => void;
}

function displayNameFor(
  convo: ConversationWithPreview
): { name: string; username: string; avatarPath: string | null } {
  const peer = convo.other_participants[0];
  if (peer) {
    return {
      name: peer.display_name?.trim() || peer.username,
      username: peer.username,
      avatarPath: peer.avatar_path,
    };
  }
  return { name: "Unknown user", username: "", avatarPath: null };
}

function ConversationRow({
  convo,
  viewerId,
}: {
  convo: ConversationWithPreview;
  viewerId: string;
}) {
  const router = useRouter();
  const { name, username, avatarPath } = displayNameFor(convo);
  const last = convo.last_message;
  const preview = last
    ? `${last.sender_id === viewerId ? "You: " : ""}${last.body}`
    : "No messages yet";

  return (
    <button
      type="button"
      onClick={() => router.push(`/inbox/${convo.id}`)}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-surface-elevated focus-visible:bg-surface-elevated"
    >
      <Avatar src={avatarUrl(avatarPath)} name={username || name} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-semibold text-ink">{name}</p>
          {last && (
            <time dateTime={last.created_at} className="shrink-0 text-xs text-ink-muted">
              {timeAgo(last.created_at)}
            </time>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm text-ink-muted">{preview}</p>
          {convo.unread_count > 0 && (
            <span
              aria-label={`${convo.unread_count} unread messages`}
              className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-blue px-1.5 text-[11px] font-semibold text-white"
            >
              {convo.unread_count > 99 ? "99+" : convo.unread_count}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export default function ConversationList({
  conversations,
  viewerId,
  loading,
  loadingMore,
  hasMore,
  error,
  onRetry,
  onLoadMore,
  query,
  onQueryChange,
}: ConversationListProps) {
  const router = useRouter();

  if (loading) {
    return (
      <div className="space-y-2 p-3" aria-label="Loading conversations">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl px-3 py-3">
            <Skeleton className="h-16 w-16 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3 rounded" />
              <Skeleton className="h-3 w-1/2 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load conversations"
          description={error}
          actionLabel="Try again"
          onAction={onRetry}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <Input
          type="search"
          placeholder="Search conversations"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label="Search conversations"
        />
      </div>
      {conversations.length === 0 ? (
        <div className="flex-1 p-6">
          <EmptyState
            title={
              query ? "No conversations match your search" : "No conversations yet"
            }
            description={
              query
                ? "Try a different name or message text."
                : "Start a chat from someone's profile to see it here."
            }
            actionLabel={query ? undefined : "Find people"}
            onAction={query ? undefined : () => router.push("/explore")}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-1 pb-4">
          <ul aria-label="Conversations">
            {conversations.map((convo) => (
              <li key={convo.id}>
                <ConversationRow convo={convo} viewerId={viewerId} />
              </li>
            ))}
          </ul>
          {hasMore && (
            <div className="flex justify-center p-4">
              <Button
                variant="secondary"
                onClick={onLoadMore}
                loading={loadingMore}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
