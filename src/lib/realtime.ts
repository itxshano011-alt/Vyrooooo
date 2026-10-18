import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "./supabase/client";
import type { Message, Notification } from "./db";

/**
 * Typed Supabase Realtime subscriptions for the VYRO frontend.
 *
 * Channel naming: `vyro:messages:<conversationId>`, `vyro:notifications:<userId>`.
 * All subscriptions filter server-side via postgres_changes filters; RLS
 * policies from migration 0008 still apply to what the socket may deliver.
 *
 * Each helper returns an unsubscribe function. The frontend is responsible
 * for calling it on unmount. Realtime must be enabled for the
 * messages/notifications tables in the Supabase dashboard (Database >
 * Replication) for these to receive events.
 */

export type Unsubscribe = () => void;

function track(channel: RealtimeChannel): Unsubscribe {
  channel.subscribe();
  return () => {
    channel.unsubscribe();
  };
}

/**
 * Subscribe to new/updated messages in one conversation. The callback fires
 * for INSERT (new message) and UPDATE (edit, soft delete via deleted_at).
 * The caller must already be a conversation participant; RLS enforces it.
 */
export function subscribeToMessages(
  conversationId: string,
  onMessage: (message: Message, event: "INSERT" | "UPDATE") => void
): Unsubscribe {
  const supabase = createClient();
  const channel = supabase
    .channel(`vyro:messages:${conversationId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "messages",
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => {
        if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
          onMessage(payload.new as Message, payload.eventType);
        }
      }
    );
  return track(channel);
}

/**
 * Subscribe to the viewer's own notifications (follows, likes, comments,
 * incoming messages). Notification rows are written by DB triggers
 * (migration 0006); clients only read them.
 */
export function subscribeToNotifications(
  userId: string,
  onNotification: (notification: Notification) => void
): Unsubscribe {
  const supabase = createClient();
  const channel = supabase
    .channel(`vyro:notifications:${userId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `recipient_id=eq.${userId}`,
      },
      (payload) => {
        onNotification(payload.new as Notification);
      }
    );
  return track(channel);
}

/**
 * Subscribe to conversation-level changes for the inbox list (updated_at
 * bumps when a new message lands, via the migration 0005 trigger). Because
 * Realtime filters cannot express "conversations I participate in", the
 * frontend should re-fetch the inbox on any event and let RLS-scoped reads
 * decide what is visible.
 */
export function subscribeToInbox(
  onEvent: (conversationId: string) => void
): Unsubscribe {
  const supabase = createClient();
  const channel = supabase
    .channel("vyro:inbox")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "conversations" },
      (payload) => {
        const row = payload.new as { id?: string };
        if (row.id) onEvent(row.id);
      }
    );
  return track(channel);
}

/**
 * Subscribe to read-receipt ticks on a conversation's messages so the chat
 * UI can render "seen" states.
 */
export function subscribeToReadReceipts(
  conversationId: string,
  onRead: (messageId: string, userId: string) => void
): Unsubscribe {
  const supabase = createClient();
  const channel = supabase
    .channel(`vyro:reads:${conversationId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "message_reads" },
      (payload) => {
        const row = payload.new as { message_id?: string; user_id?: string };
        if (row.message_id && row.user_id) onRead(row.message_id, row.user_id);
      }
    );
  return track(channel);
}
