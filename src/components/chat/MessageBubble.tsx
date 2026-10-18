"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { timeAgo } from "@/lib/format";
import type { MessageWithSender } from "@/lib/db";
import { attachmentKind, attachmentUrl, avatarUrl } from "./urls";
import { formatFullDateTime, formatMessageTime } from "./dates";

/**
 * A chat message owned by the client that has not been confirmed by the
 * server yet (or failed to send). Distinguished from server messages by
 * the `status` field.
 */
export interface PendingChatMessage {
  /** Client-generated id: `pending-<uuid>`. Never collides with server ids. */
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  /** Storage path, or the literal "uploading" while the file is uploading. */
  attachment_path: string | null;
  created_at: string;
  sender: MessageWithSender["sender"];
  status: "sending" | "failed";
}

export type ChatMessage = MessageWithSender | PendingChatMessage;

export function isPending(message: ChatMessage): message is PendingChatMessage {
  return "status" in message && typeof message.status === "string";
}

interface MessageBubbleProps {
  message: ChatMessage;
  /** Whether the viewer sent this message. */
  isOwn: boolean;
  /** For own messages: whether another participant has read it. */
  seenByPeer: boolean;
  /** Show the sender's avatar (first in a consecutive group). */
  showAvatar: boolean;
  onRetry: (tempId: string) => void;
  onDiscard: (tempId: string) => void;
}

function AttachmentView({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const kind = attachmentKind(path);

  useEffect(() => {
    let cancelled = false;
    attachmentUrl(path)
      .then((signed) => {
        if (!cancelled) {
          if (signed) setUrl(signed);
          else setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) {
    return (
      <p className="text-xs text-ink-muted">Attachment could not be loaded.</p>
    );
  }
  if (!url) {
    return (
      <div className="flex h-24 w-48 items-center justify-center rounded-lg bg-surface">
        <Spinner size="md" />
      </div>
    );
  }
  if (kind === "image") {
    return (
      // Plain img: Next Image requires remotePatterns for signed URLs.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt="Image attachment"
        className="max-h-64 w-auto rounded-lg object-contain"
        loading="lazy"
      />
    );
  }
  if (kind === "video") {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-64 w-auto rounded-lg"
      />
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      Open attachment
    </a>
  );
}

export default function MessageBubble({
  message,
  isOwn,
  seenByPeer,
  showAvatar,
  onRetry,
  onDiscard,
}: MessageBubbleProps) {
  const pending = isPending(message);
  const failed = pending && message.status === "failed";
  const uploading = pending && message.attachment_path === "uploading";

  return (
    <div
      className={`flex items-end gap-2 ${isOwn ? "justify-end" : "justify-start"}`}
    >
      {!isOwn && (
        <div className="w-8 shrink-0">
          {showAvatar && (
            <Link
              href={`/profile/${message.sender.username}`}
              aria-label={`View ${message.sender.username}'s profile`}
            >
              <Avatar
                src={avatarUrl(message.sender.avatar_path)}
                name={message.sender.username}
                size="sm"
              />
            </Link>
          )}
        </div>
      )}
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 ${
          isOwn
            ? "rounded-br-md bg-brand-blue text-white"
            : "rounded-bl-md bg-surface-elevated text-ink"
        } ${failed ? "opacity-70" : ""}`}
      >
        {message.attachment_path && !uploading && (
          <div className="mb-1">
            <AttachmentView path={message.attachment_path} />
          </div>
        )}
        {uploading && !failed && (
          <div className="mb-1 flex items-center gap-2 text-xs opacity-80">
            <Spinner size="sm" /> Uploading attachment
          </div>
        )}
        {/* Message bodies are plain text by contract; never innerHTML. */}
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.body}
        </p>
        <div
          className={`mt-1 flex items-center gap-1 text-[11px] ${
            isOwn ? "justify-end text-white/70" : "justify-start text-ink-muted"
          }`}
        >
          <time
            dateTime={message.created_at}
            title={formatFullDateTime(message.created_at)}
          >
            {formatMessageTime(message.created_at)}
          </time>
          <span aria-hidden="true">·</span>
          <span>{timeAgo(message.created_at)}</span>
          {pending && message.status === "sending" && <span>Sending</span>}
          {isOwn && !pending && seenByPeer && <span>Seen</span>}
        </div>
        {failed && (
          <div className="mt-2 flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRetry(message.id)}
              className={isOwn ? "!text-white" : ""}
            >
              Retry
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDiscard(message.id)}
              className={isOwn ? "!text-white" : ""}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
