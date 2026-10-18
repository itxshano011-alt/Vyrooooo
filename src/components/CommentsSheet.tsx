"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { createClient } from "@/lib/supabase/client";
import type { Comment, VideoWithDetails } from "@/lib/db";
import type { Profile } from "@/lib/db";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { avatarUrl } from "@/lib/media";
import { timeAgo } from "@/lib/format";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/components/ui/Toast";
import { Avatar } from "@/components/ui/Avatar";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReportDialog } from "@/components/ReportDialog";

type CommentAuthor = Pick<Profile, "id" | "username" | "display_name" | "avatar_path" | "verified">;
export interface CommentWithAuthor extends Comment {
  author: CommentAuthor;
}

/**
 * Bottom sheet for video comments.
 *
 * Props:
 *   video: the video whose comments to show; null closes the sheet.
 *   onClose(): called when the sheet is dismissed.
 *   onCountChange?(videoId, delta): lets the parent adjust its comment count.
 *
 * - Paginated (cursor) with "load more". Posting requires sign-in.
 * - Authors can edit/delete their own; the video creator can delete any.
 * - Non-owners can report a comment via ReportDialog.
 */
export function CommentsSheet({
  video,
  onClose,
  onCountChange,
}: {
  video: VideoWithDetails | null;
  onClose: () => void;
  onCountChange?: (videoId: string, delta: number) => void;
}) {
  const open = video !== null;
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Comments"
        className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-t-2xl bg-surface-elevated"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-bold text-ink">
            Comments
            <span className="ml-2 text-sm font-normal text-ink-muted">
              {video.comment_count}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comments"
            className="rounded-lg p-1 text-ink-muted hover:text-ink"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <CommentList video={video} onCountChange={onCountChange} />
      </div>
    </div>
  );
}

function CommentList({
  video,
  onCountChange,
}: {
  video: VideoWithDetails;
  onCountChange?: (videoId: string, delta: number) => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const supabase = useMemo(() => createClient(), []);

  const [comments, setComments] = useState<CommentWithAuthor[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ body: string }>({ defaultValues: { body: "" } });

  const loadPage = useCallback(
    async (cursorToUse: string | null, append: boolean) => {
      try {
        const params = cursorToUse ? `?cursor=${encodeURIComponent(cursorToUse)}` : "";
        const data = await apiRequest<{ comments: CommentWithAuthor[]; next_cursor: string | null }>(
          `/api/videos/${video.id}/comments${params}`
        );
        setComments((prev) => {
          const merged = append ? [...prev, ...data.comments] : data.comments;
          const seen = new Set<string>();
          return merged.filter((c) => {
            if (seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
          });
        });
        setCursor(data.next_cursor);
        setHasMore(data.next_cursor !== null);
        setError(null);
      } catch (e) {
        setError(errorMessage(e, "Could not load comments"));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [video.id]
  );

  useEffect(() => {
    setComments([]);
    setCursor(null);
    setHasMore(true);
    setLoading(true);
    void loadPage(null, false);
  }, [video.id, loadPage]);

  const postComment = async (values: { body: string }) => {
    const body = values.body.trim();
    if (!body) return;
    try {
      const data = await apiRequest<{ comment: CommentWithAuthor }>(
        `/api/videos/${video.id}/comments`,
        { method: "POST", json: { body } }
      );
      setComments((prev) => [data.comment, ...prev]);
      onCountChange?.(video.id, 1);
      reset();
    } catch (e) {
      toast(errorMessage(e, "Could not post comment"), "error");
    }
  };

  const saveEdit = async (commentId: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    try {
      const data = await apiRequest<{ comment: Comment }>(`/api/comments/${commentId}`, {
        method: "PATCH",
        json: { body: trimmed },
      });
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? { ...c, body: data.comment.body } : c))
      );
      setEditingId(null);
    } catch (e) {
      toast(errorMessage(e, "Could not update comment"), "error");
    }
  };

  const deleteComment = async (commentId: string) => {
    try {
      await apiRequest(`/api/comments/${commentId}`, { method: "DELETE" });
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      onCountChange?.(video.id, -1);
      setMenuFor(null);
    } catch (e) {
      toast(errorMessage(e, "Could not delete comment"), "error");
    }
  };

  const canDelete = (comment: CommentWithAuthor): boolean =>
    user !== null && (comment.author_id === user.id || video.creator_id === user.id);
  const canEdit = (comment: CommentWithAuthor): boolean =>
    user !== null && comment.author_id === user.id;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner label="Loading comments" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-ink-muted">{error}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setLoading(true);
                void loadPage(null, false);
              }}
            >
              Retry
            </Button>
          </div>
        ) : comments.length === 0 ? (
          <EmptyState title="No comments yet" description="Be the first to share your thoughts." />
        ) : (
          <ul className="flex flex-col gap-4">
            {comments.map((comment) => (
              <li key={comment.id} className="flex gap-3">
                <Avatar
                  src={avatarUrl(supabase, comment.author.avatar_path)}
                  name={comment.author.username}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-bold text-ink">
                      @{comment.author.username}
                    </span>
                    <span className="text-xs text-ink-muted">{timeAgo(comment.created_at)}</span>
                  </div>
                  {editingId === comment.id ? (
                    <EditCommentForm
                      initial={comment.body}
                      onCancel={() => setEditingId(null)}
                      onSave={(body) => void saveEdit(comment.id, body)}
                    />
                  ) : (
                    <p className="mt-0.5 break-words text-sm text-ink">{comment.body}</p>
                  )}
                  {(canEdit(comment) || canDelete(comment) || user) && (
                    <div className="relative mt-1">
                      <button
                        type="button"
                        onClick={() => setMenuFor(menuFor === comment.id ? null : comment.id)}
                        aria-label="Comment options"
                        aria-expanded={menuFor === comment.id}
                        className="text-xs font-medium text-ink-muted hover:text-ink"
                      >
                        Options
                      </button>
                      {menuFor === comment.id && (
                        <div className="absolute left-0 z-10 mt-1 w-40 rounded-xl border border-border bg-surface p-1 shadow-lg">
                          {canEdit(comment) && (
                            <MenuItem
                              label="Edit"
                              onClick={() => {
                                setEditingId(comment.id);
                                setMenuFor(null);
                              }}
                            />
                          )}
                          {canDelete(comment) && (
                            <MenuItem
                              label="Delete"
                              danger
                              onClick={() => void deleteComment(comment.id)}
                            />
                          )}
                          {!canEdit(comment) && (
                            <MenuItem
                              label="Report"
                              onClick={() => {
                                setReportTarget(comment.id);
                                setMenuFor(null);
                              }}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {hasMore && !loading && !error && comments.length > 0 && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              loading={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                void loadPage(cursor, true);
              }}
            >
              Load more comments
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-border px-4 py-3">
        {user ? (
          <form onSubmit={handleSubmit(postComment)} className="flex gap-2">
            <Input
              {...register("body", { required: true, maxLength: 500 })}
              placeholder="Add a comment..."
              aria-label="Add a comment"
              maxLength={500}
              autoComplete="off"
            />
            <Button type="submit" loading={isSubmitting} disabled={isSubmitting}>
              Post
            </Button>
          </form>
        ) : (
          <p className="py-2 text-center text-sm text-ink-muted">
            Sign in to join the conversation.
          </p>
        )}
      </div>

      <ReportDialog
        targetType="comment"
        targetId={reportTarget}
        open={reportTarget !== null}
        onClose={() => setReportTarget(null)}
      />
    </>
  );
}

function MenuItem({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-elevated ${
        danger ? "text-red-500" : "text-ink"
      }`}
    >
      {label}
    </button>
  );
}

function EditCommentForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="mt-1 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={500}
        aria-label="Edit comment"
        autoFocus
      />
      <Button type="submit" size="sm">
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
