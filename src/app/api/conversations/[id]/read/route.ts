import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  validationError,
} from "@/lib/api-errors";
import { conversationReadSchema } from "@/lib/validation";

/** Cap on receipts written per call; keeps a huge backlog from stalling. */
const READ_BATCH_LIMIT = 500;

/**
 * Mark messages as read up to and including { up_to_message_id }.
 * Writes append-only read receipts (message_reads has no UPDATE/DELETE via
 * RLS); upsert with ignoreDuplicates makes the call idempotent.
 */
export const POST = handleRoute(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id: conversationId } = await params;
    const { user } = await requireProfile();

    const parsed = conversationReadSchema.safeParse(await request.json());
    if (!parsed.success) throw validationError(parsed.error);

    const supabase = await createClient();

    const { data: participant } = await supabase.rpc(
      "is_conversation_participant",
      { p_conversation_id: conversationId }
    );
    if (participant !== true) throw notFound("Conversation not found");

    const { data: anchor, error: anchorError } = await supabase
      .from("messages")
      .select("created_at")
      .eq("id", parsed.data.up_to_message_id)
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (anchorError) throw fromPostgrestError(anchorError);
    if (!anchor) throw notFound("Message not found");

    const { data: unread, error: unreadError } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .neq("sender_id", user.id)
      .is("deleted_at", null)
      .lte("created_at", (anchor as { created_at: string }).created_at)
      .limit(READ_BATCH_LIMIT);
    if (unreadError) throw fromPostgrestError(unreadError);
    const ids = ((unread ?? []) as { id: string }[]).map((m) => m.id);
    if (ids.length === 0) {
      return NextResponse.json({ marked_read: 0 });
    }

    const { error: upsertError } = await supabase
      .from("message_reads")
      .upsert(
        ids.map((message_id) => ({ message_id, user_id: user.id })),
        { onConflict: "message_id,user_id", ignoreDuplicates: true }
      );
    if (upsertError) throw fromPostgrestError(upsertError);

    return NextResponse.json({ marked_read: ids.length });
  }
);
