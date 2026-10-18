"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAuth } from "@/hooks/useAuth";
import {
  subscribeToMessages,
  subscribeToReadReceipts,
} from "@/lib/realtime";
import { formatDayDivider } from "./dates";
import type {
  ConversationWithPreview,
  Message,
  MessageWithSender,
  Profile,
} from "@/lib/db";
import MessageBubble, {
  ChatMessage,
  PendingChatMessage,
  isPending,
} from "./MessageBubble";
import { avatarUrl } from "./urls";

const PAGE_SIZE = 30;
const MESSAGE_MAX = 2000;
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_EXTS = ["jpg", "jpeg", "png", "webp", "mp4", "pdf"];

type Peer = Pick<
  Profile,
  "id" | "username" | "display_name" | "avatar_path" | "verified"
>;

interface ChatWindowProps {
  conversationId: string;
}

interface SendAttachment {
  file: File;
  previewUrl: string;
  kind: "image" | "video" | "pdf";
}

function newTempId(): string {
  return `pending-${crypto.randomUUID()}`;
}

/** Extract a human-readable message from an API error body. */
async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as {
      error?: { message?: string };
    };
    return data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export default function ChatWindow({ conversationId }: ChatWindowProps) {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();
  const viewerId = profile?.id ?? null;

  const [peer, setPeer] = useState<Peer | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<SendAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  /** Server message ids the peer has read (for "Seen" on own messages). */
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const reducedMotion = useRef(false);
  const markReadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  /** Files backing optimistic messages whose upload has not succeeded yet. */
  const pendingFiles = useRef(new Map<string, File>());

  useEffect(() => {
    reducedMotion.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
  }, []);

  const scrollToBottom = useCallback((instant = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const behavior: ScrollBehavior =
      instant || reducedMotion.current ? "auto" : "smooth";
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // ------------------------------------------------------------------
  // History loading
  // ------------------------------------------------------------------
  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setLoadError(null);
    setNotFound(false);
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}`,
        { credentials: "include" }
      );
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error(await apiErrorMessage(res, "Could not load messages"));
      const data = (await res.json()) as {
        messages: MessageWithSender[];
        next_cursor: string | null;
      };
      // API returns newest first; chat displays oldest first.
      setMessages([...data.messages].reverse());
      setCursor(data.next_cursor);
      setHasMore(data.next_cursor !== null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load messages");
    } finally {
      setLoadingHistory(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!authLoading && viewerId) void loadHistory();
  }, [authLoading, viewerId, loadHistory]);

  // Peer identity for the header: resolve from the inbox list.
  useEffect(() => {
    if (!authLoading && !viewerId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/conversations?limit=50", {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          conversations: ConversationWithPreview[];
        };
        const convo = data.conversations.find((c) => c.id === conversationId);
        const found = convo?.other_participants[0] ?? null;
        if (!cancelled && found) {
          setPeer(found);
          // Realtime inserts that arrived before this lookup used a
          // placeholder sender; backfill the real identity.
          const identity = {
            id: found.id,
            username: found.username,
            display_name: found.display_name,
            avatar_path: found.avatar_path,
            verified: found.verified,
          };
          setMessages((prev) =>
            prev.map((m) =>
              !isPending(m) &&
              m.sender_id === found.id &&
              m.sender.username === "user"
                ? { ...m, sender: identity }
                : m
            )
          );
        }
      } catch {
        // Header degrades to a generic label; messages still work.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, viewerId, conversationId]);

  // Fallback: derive the peer from message senders when the inbox lookup
  // did not include this conversation.
  useEffect(() => {
    if (peer || !viewerId) return;
    const other = messages.find(
      (m) => !isPending(m) && m.sender_id !== viewerId
    );
    if (other && !isPending(other)) setPeer(other.sender);
  }, [messages, peer, viewerId]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(await apiErrorMessage(res, "Could not load older messages"));
      const data = (await res.json()) as {
        messages: MessageWithSender[];
        next_cursor: string | null;
      };
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      setMessages((prev) => [...[...data.messages].reverse(), ...prev]);
      setCursor(data.next_cursor);
      setHasMore(data.next_cursor !== null);
      // Keep the scroll position anchored after prepending.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch {
      // Non-fatal: the button stays available for another attempt.
    } finally {
      setLoadingMore(false);
    }
  }, [conversationId, cursor, loadingMore]);

  // ------------------------------------------------------------------
  // Read receipts
  // ------------------------------------------------------------------
  const markRead = useCallback(
    async (upToId: string) => {
      try {
        await fetch(`/api/conversations/${conversationId}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ up_to_message_id: upToId }),
        });
      } catch {
        // Best effort; the next view attempt retries.
      }
    },
    [conversationId]
  );

  const scheduleMarkRead = useCallback(() => {
    if (markReadTimer.current) clearTimeout(markReadTimer.current);
    markReadTimer.current = setTimeout(() => {
      const newestOther = [...messagesRef.current]
        .reverse()
        .find((m) => !isPending(m) && m.sender_id !== viewerId);
      if (newestOther && !isPending(newestOther)) {
        void markRead(newestOther.id);
      }
    }, 800);
  }, [markRead, viewerId]);

  useEffect(() => {
    scheduleMarkRead();
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleMarkRead();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (markReadTimer.current) clearTimeout(markReadTimer.current);
    };
  }, [scheduleMarkRead]);

  // ------------------------------------------------------------------
  // Realtime
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!viewerId || notFound) return;

    const unsubMessages = subscribeToMessages(conversationId, (msg, event) => {
      if (event === "INSERT") {
        const incoming = msg as Message;
        setMessages((prev) => {
          if (prev.some((m) => !isPending(m) && m.id === incoming.id)) {
            return prev;
          }
          // A confirmed self-send may already sit in state if the POST
          // resolved before the socket event; the POST handler replaces
          // the pending entry by temp id, so reaching here means this is
          // genuinely new (or from the peer).
          return [
            ...prev,
            {
              ...(incoming as Message),
              sender:
                incoming.sender_id === viewerId && profile
                  ? {
                      id: profile.id,
                      username: profile.username,
                      display_name: profile.display_name,
                      avatar_path: profile.avatar_path,
                      verified: profile.verified,
                    }
                  : peer
                    ? {
                        id: peer.id,
                        username: peer.username,
                        display_name: peer.display_name,
                        avatar_path: peer.avatar_path,
                        verified: peer.verified,
                      }
                    : {
                        id: incoming.sender_id,
                        username: "user",
                        display_name: null,
                        avatar_path: null,
                        verified: false,
                      },
            } as MessageWithSender,
          ];
        });
        if (incoming.sender_id !== viewerId) {
          scheduleMarkRead();
          if (isNearBottom()) scrollToBottom();
        }
      } else {
        // UPDATE: edits, or soft delete (deleted_at set -> drop the row).
        setMessages((prev) => {
          const updated = msg as Message;
          if (updated.deleted_at) {
            return prev.filter((m) => m.id !== updated.id);
          }
          return prev.map((m) =>
            !isPending(m) && m.id === updated.id
              ? { ...m, ...updated, sender: m.sender }
              : m
          );
        });
      }
    });

    const unsubReads = subscribeToReadReceipts(
      conversationId,
      (messageId, userId) => {
        if (userId !== viewerId) {
          setSeenIds((prev) => {
            const next = new Set(prev);
            next.add(messageId);
            return next;
          });
        }
      }
    );

    return () => {
      unsubMessages();
      unsubReads();
    };
  }, [conversationId, viewerId, notFound, peer, profile, scheduleMarkRead, scrollToBottom, isNearBottom]);

  // Scroll to bottom after the initial history load.
  useEffect(() => {
    if (!loadingHistory && messages.length > 0) scrollToBottom(true);
    // Only on the first successful load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingHistory]);

  // ------------------------------------------------------------------
  // Sending
  // ------------------------------------------------------------------
  const uploadAttachment = useCallback(async (file: File): Promise<string> => {
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    const signRes = await fetch("/api/upload/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ kind: "chat-attachment", ext }),
    });
    if (!signRes.ok) {
      throw new Error(await apiErrorMessage(signRes, "Could not prepare upload"));
    }
    const { upload_url, path } = (await signRes.json()) as {
      upload_url: string;
      path: string;
    };
    const putRes = await fetch(upload_url, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (!putRes.ok) throw new Error("Upload failed. Try again.");
    return path;
  }, []);

  const postMessage = useCallback(
    async (temp: PendingChatMessage) => {
      setMessages((prev) =>
        prev.map((m) =>
          isPending(m) && m.id === temp.id
            ? { ...m, status: "sending" as const }
            : m
        )
      );
      setSendError(null);
      // Upload first (if still needed), then POST the message row.
      let path: string | null =
        temp.attachment_path === "uploading" ? null : temp.attachment_path;
      try {
        if (temp.attachment_path === "uploading") {
          const file = pendingFiles.current.get(temp.id);
          if (!file) {
            throw new Error(
              "The attached file is no longer available. Pick it again and retry."
            );
          }
          path = await uploadAttachment(file);
        }
        const res = await fetch(
          `/api/conversations/${conversationId}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              body: temp.body,
              ...(path ? { attachment_path: path } : {}),
            }),
          }
        );
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error("This conversation is no longer available.");
          }
          throw new Error(await apiErrorMessage(res, "Message could not be sent"));
        }
        const data = (await res.json()) as { message: MessageWithSender };
        pendingFiles.current.delete(temp.id);
        setMessages((prev) => {
          // The realtime socket may have delivered this message before the
          // POST resolved; drop that copy and swap the pending entry in
          // place so there is exactly one row with the server id.
          const withoutDupe = prev.filter(
            (m) => !(m.id === data.message.id && (!isPending(m) || m.id !== temp.id))
          );
          return withoutDupe.map((m) =>
            isPending(m) && m.id === temp.id ? data.message : m
          );
        });
        scrollToBottom();
      } catch (err) {
        // Keep the real uploaded path on failure so a retry does not
        // re-upload; keep the "uploading" marker when the upload itself
        // failed so the retry tries the upload again.
        setMessages((prev) =>
          prev.map((m) =>
            isPending(m) && m.id === temp.id
              ? {
                  ...m,
                  status: "failed" as const,
                  attachment_path: temp.attachment_path === "uploading" && !path
                    ? "uploading"
                    : path,
                }
              : m
          )
        );
        setSendError(err instanceof Error ? err.message : "Message could not be sent");
      }
    },
    [conversationId, uploadAttachment, scrollToBottom]
  );

  const handleSend = useCallback(() => {
    if (!viewerId || !profile || uploading) return;
    const body = draft.trim();
    if (!body && !attachment) return;
    if (body.length > MESSAGE_MAX) return;

    const temp: PendingChatMessage = {
      id: newTempId(),
      conversation_id: conversationId,
      sender_id: viewerId,
      body: body || "Sent an attachment",
      attachment_path: attachment ? "uploading" : null,
      created_at: new Date().toISOString(),
      sender: {
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        avatar_path: profile.avatar_path,
        verified: profile.verified,
      },
      status: "sending",
    };
    if (attachment) pendingFiles.current.set(temp.id, attachment.file);
    setMessages((prev) => [...prev, temp]);
    setDraft("");
    setAttachment(null);
    if (composerRef.current) composerRef.current.style.height = "auto";
    setUploading(true);
    scrollToBottom();
    void postMessage(temp).finally(() => setUploading(false));
  }, [viewerId, profile, uploading, draft, attachment, conversationId, postMessage, scrollToBottom]);

  const handleRetry = useCallback(
    (tempId: string) => {
      const temp = messagesRef.current.find(
        (m): m is PendingChatMessage => isPending(m) && m.id === tempId
      );
      if (!temp) return;
      setUploading(true);
      void postMessage(temp).finally(() => setUploading(false));
    },
    [postMessage]
  );

  const handleDiscard = useCallback((tempId: string) => {
    pendingFiles.current.delete(tempId);
    setMessages((prev) => prev.filter((m) => m.id !== tempId));
  }, []);

  // ------------------------------------------------------------------
  // Attachment picking
  // ------------------------------------------------------------------
  const handlePickFile = useCallback((file: File | undefined) => {
    setSendError(null);
    if (!file) return;
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!ATTACHMENT_EXTS.includes(ext)) {
      setSendError(
        `File type .${ext || "?"} is not supported. Use ${ATTACHMENT_EXTS.join(", ")}.`
      );
      return;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setSendError("File is too large. Maximum size is 25 MB.");
      return;
    }
    const kind: SendAttachment["kind"] =
      ["jpg", "jpeg", "png", "webp"].includes(ext)
        ? "image"
        : ext === "mp4"
          ? "video"
          : "pdf";
    setAttachment({
      file,
      previewUrl: kind === "pdf" ? "" : URL.createObjectURL(file),
      kind,
    });
  }, []);

  useEffect(() => {
    return () => {
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, [attachment]);

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------
  const items = useMemo(() => {
    const out: { key: string; node: "divider" | "message"; message?: ChatMessage; label?: string }[] = [];
    let lastDay = "";
    for (const message of messages) {
      const day = new Date(message.created_at).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        out.push({
          key: `divider-${message.id}`,
          node: "divider",
          label: formatDayDivider(message.created_at),
        });
      }
      out.push({ key: message.id, node: "message", message });
    }
    return out;
  }, [messages]);

  const peerName = peer
    ? peer.display_name?.trim() || peer.username
    : "Conversation";
  const peerHref = peer ? `/profile/${peer.username}` : "/inbox";

  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6">
        <EmptyState
          title="Conversation not found"
          description="It may have been removed, or you don't have access to it."
          actionLabel="Back to inbox"
          onAction={() => router.push("/inbox")}
        />
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-surface">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.back()}
          aria-label="Back to inbox"
          className="h-9 w-9 !px-0"
        >
          ←
        </Button>
        <Link href={peerHref} className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar
            src={avatarUrl(peer?.avatar_path)}
            name={peer?.username ?? peerName}
            size="md"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{peerName}</p>
            {peer && (
              <p className="truncate text-xs text-ink-muted">@{peer.username}</p>
            )}
          </div>
        </Link>
      </header>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-4"
        role="log"
        aria-live="polite"
        aria-label="Message history"
      >
        {loadingHistory ? (
          <div className="space-y-3" aria-label="Loading messages">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className={`flex ${i % 2 === 0 ? "justify-start" : "justify-end"}`}
              >
                <Skeleton className="h-10 w-2/3 rounded-2xl" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div className="p-6">
            <EmptyState
              title="Couldn't load messages"
              description={loadError}
              actionLabel="Try again"
              onAction={() => void loadHistory()}
            />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              title="No messages yet"
              description="Say hello to start the conversation."
            />
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="mb-4 flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadOlder()}
                  loading={loadingMore}
                >
                  Load older messages
                </Button>
              </div>
            )}
            <div className="space-y-3">
              {items.map((item) =>
                item.node === "divider" ? (
                  <div key={item.key} className="flex justify-center py-1">
                    <span className="rounded-full bg-surface-elevated px-3 py-1 text-[11px] text-ink-muted">
                      {item.label}
                    </span>
                  </div>
                ) : (
                  (() => {
                    const m = item.message as ChatMessage;
                    const own = m.sender_id === viewerId;
                    return (
                      <MessageBubble
                        key={item.key}
                        message={m}
                        isOwn={own}
                        seenByPeer={own && !isPending(m) && seenIds.has(m.id)}
                        showAvatar={true}
                        onRetry={handleRetry}
                        onDiscard={handleDiscard}
                      />
                    );
                  })()
                )
              )}
            </div>
          </>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        {sendError && (
          <p role="alert" className="mb-2 text-xs text-red-400">
            {sendError}
          </p>
        )}
        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-xl bg-surface-elevated p-2">
            {attachment.kind === "image" && attachment.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={attachment.previewUrl}
                alt="Attachment preview"
                className="h-14 w-14 rounded-lg object-cover"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-surface text-xs text-ink-muted">
                {attachment.kind === "video" ? "Video" : "PDF"}
              </div>
            )}
            <p className="min-w-0 flex-1 truncate text-xs text-ink-muted">
              {attachment.file.name}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAttachment(null)}
              aria-label="Remove attachment"
            >
              Remove
            </Button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.mp4,.pdf"
            className="hidden"
            aria-label="Attach a file"
            onChange={(e) => {
              handlePickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Attach image, video, or PDF"
            className="h-9 w-9 !px-0"
          >
            +
          </Button>
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            maxLength={MESSAGE_MAX}
            placeholder="Message"
            aria-label="Message"
            className="max-h-32 flex-1 resize-none rounded-2xl border border-border bg-surface-elevated px-4 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand-blue focus:outline-none"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleSend}
            loading={uploading}
            disabled={!draft.trim() && !attachment}
            aria-label="Send message"
            className="h-9 w-9 !px-0"
          >
            {!uploading && "↑"}
          </Button>
        </div>
        <p className="mt-1 text-right text-[11px] text-ink-muted">
          {draft.length}/{MESSAGE_MAX}
        </p>
      </div>
    </div>
  );
}
