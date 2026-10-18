import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser, requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  forbidden,
  unauthorized,
  validationError,
} from "@/lib/api-errors";
import { messageCreateSchema } from "@/lib/validation";
import {
  messageLimiter,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";
import {
  cursorFilter,
  fetchVisibleProfiles,
  nextCursorFor,
  parsePagination,
  storagePathOwner,
  type Message,
  type ReadContext,
} from "@/lib/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Participant check that does not leak conversation existence: a
 * non-participant (or a nonexistent id) gets the same 404. Uses the
 * SECURITY DEFINER helper from migration 0005.
 */
async function requireParticipant(
  supabase: ServerClient,
  conversationId: string
): Promise<void> {
  const { data, error } = await supabase.rpc("is_conversation_participant", {
    p_conversation_id: conversationId,
  });
  if (error) throw fromPostgrestError(error);
  if (data !== true) throw notFound("Conversation not found");
}

/**
 * Message history, newest first, cursor-paginated (?cursor=, or ?before=
 * with a message id). The client reverses the page for chat display.
 * Soft-deleted messages are excluded by RLS. Senders whose profile is not
 * visible to the viewer (e.g. a peer who blocked them) come back with
 * sender: null rather than dropping the message.
 */
export const GET = handleRoute(async (request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const session = await getSessionUser();
  if (!session) {
    throw unauthorized("Sign in to read messages");
  }
  const viewerId = session.user.id;

  const supabase = await createClient();
  await requireParticipant(supabase, id);

  const searchParams = new URL(request.url).searchParams;
  const { cursor: queryCursor, limit } = parsePagination(searchParams);

  let cursor = queryCursor;
  const before = searchParams.get("before");
  if (before) {
    const { data: anchor, error: anchorError } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("id", before)
      .eq("conversation_id", id)
      .maybeSingle();
    if (anchorError) throw fromPostgrestError(anchorError);
    if (!anchor) throw notFound("Message not found");
    const a = anchor as { id: string; created_at: string };
    cursor = { created_at: a.created_at, id: a.id };
  }

  let query = supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  const filter = cursorFilter(cursor);
  if (filter) query = query.or(filter);

  const { data, error } = await query;
  if (error) throw fromPostgrestError(error);
  const messages = (data ?? []) as Message[];

  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId };
  const senders = await fetchVisibleProfiles(
    ctx,
    messages.map((m) => m.sender_id)
  );

  return NextResponse.json({
    messages: messages.map((m) => {
      const sender = senders.get(m.sender_id);
      return {
        ...m,
        sender: sender
          ? {
              id: sender.id,
              username: sender.username,
              display_name: sender.display_name,
              avatar_path: sender.avatar_path,
              verified: sender.verified,
            }
          : null,
      };
    }),
    next_cursor: nextCursorFor(messages, limit),
  });
});

/**
 * Send a message. The INSERT RLS policy re-validates participation and the
 * no-block rule at the database level. A read receipt for the sender is
 * recorded, and the notify_on_message trigger fans out notifications to the
 * other participants (skipping blocked pairs).
 */
export const POST = handleRoute(async (request: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const { user, profile } = await requireProfile();

  const parsed = messageCreateSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);

  enforceRateLimit(messageLimiter, rateLimitKey(user.id, request));

  if (
    parsed.data.attachment_path !== undefined &&
    parsed.data.attachment_path !== null
  ) {
    const owner = storagePathOwner(parsed.data.attachment_path);
    if (owner !== user.id) {
      throw forbidden("attachment_path must be a file you uploaded");
    }
    await assertAttachmentExists(parsed.data.attachment_path, user.id);
  }

  const supabase = await createClient();
  await requireParticipant(supabase, id);

  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: id,
      sender_id: user.id,
      body: parsed.data.body,
      attachment_path: parsed.data.attachment_path ?? null,
    })
    .select("*")
    .single();
  if (error) {
    // A block formed after the participant check surfaces here as an RLS
    // denial; surface it as 403 rather than leaking internals.
    if (error.code === "42501") {
      throw forbidden("You cannot send messages in this conversation");
    }
    throw fromPostgrestError(error, "Could not send message");
  }
  const message = data as Message;

  // Sender's own read receipt (message_reads is append-only; ignoreDuplicates
  // makes retries safe).
  const { error: readError } = await supabase.from("message_reads").upsert(
    { message_id: message.id, user_id: user.id },
    { onConflict: "message_id,user_id", ignoreDuplicates: true }
  );
  if (readError) throw fromPostgrestError(readError);

  return NextResponse.json(
    {
      message: {
        ...message,
        sender: {
          id: profile.id,
          username: profile.username,
          display_name: profile.display_name,
          avatar_path: profile.avatar_path,
          verified: profile.verified,
        },
      },
    },
    { status: 201 }
  );
});

async function assertAttachmentExists(
  path: string,
  ownerId: string
): Promise<void> {
  const fileName = path.split("/")[1];
  if (!fileName) throw forbidden("Invalid attachment path");
  const { data, error } = await adminClient.storage
    .from("chat-attachments")
    .list(ownerId, { search: fileName, limit: 1 });
  if (error) throw fromPostgrestError(error);
  if (!data || data.length === 0) {
    throw notFound(
      "Attachment file not found. Upload it via POST /api/upload/sign first."
    );
  }
}
