import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  notFound,
  badRequest,
  forbidden,
  validationError,
} from "@/lib/api-errors";
import { conversationCreateSchema } from "@/lib/validation";
import {
  cursorFilter,
  fetchVisibleProfiles,
  nextCursorFor,
  parsePagination,
  type Conversation,
  type ConversationWithPreview,
  type Message,
  type Profile,
  type ReadContext,
} from "@/lib/db";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Inbox: the viewer's conversations, most recently active first
 * (conversations.updated_at is bumped by a DB trigger on every message),
 * with the other participants, a last-message preview, and unread counts.
 */
export const GET = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();
  const supabase = await createClient();
  const { cursor, limit } = parsePagination(new URL(request.url).searchParams);

  const { data: myRows, error: myError } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", user.id);
  if (myError) throw fromPostgrestError(myError);
  const myConversationIds = ((myRows ?? []) as { conversation_id: string }[]).map(
    (r) => r.conversation_id
  );
  if (myConversationIds.length === 0) {
    return NextResponse.json({ conversations: [], next_cursor: null });
  }

  let convQuery = supabase
    .from("conversations")
    .select("*")
    .in("id", myConversationIds)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  const convFilter = cursorFilter(cursor, "updated_at", "id");
  if (convFilter) convQuery = convQuery.or(convFilter);

  const { data: convRows, error: convError } = await convQuery;
  if (convError) throw fromPostgrestError(convError);
  const conversations = (convRows ?? []) as Conversation[];
  if (conversations.length === 0) {
    return NextResponse.json({ conversations: [], next_cursor: null });
  }
  const pageIds = conversations.map((c) => c.id);

  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId: user.id };

  const [participantRows, previews] = await Promise.all([
    supabase
      .from("conversation_participants")
      .select("conversation_id, user_id")
      .in("conversation_id", pageIds)
      .neq("user_id", user.id)
      .then((res) => {
        if (res.error) throw fromPostgrestError(res.error);
        return (res.data ?? []) as {
          conversation_id: string;
          user_id: string;
        }[];
      }),
    Promise.all(
      pageIds.map(async (conversationId) => {
        const [lastMessage, unread] = await Promise.all([
          lastMessageFor(supabase, conversationId),
          unreadCountFor(supabase, user.id, conversationId),
        ]);
        return { conversationId, lastMessage, unread };
      })
    ),
  ]);

  const peerIds = [...new Set(participantRows.map((p) => p.user_id))];
  const peers = await fetchVisibleProfiles(ctx, peerIds);
  const peersByConv = new Map<string, Profile[]>();
  for (const row of participantRows) {
    const peer = peers.get(row.user_id);
    if (!peer) continue;
    const list = peersByConv.get(row.conversation_id) ?? [];
    list.push(peer);
    peersByConv.set(row.conversation_id, list);
  }

  const result: ConversationWithPreview[] = conversations.map((c) => {
    const preview = previews.find((p) => p.conversationId === c.id);
    return {
      ...c,
      other_participants: (peersByConv.get(c.id) ?? []).map((p) => ({
        id: p.id,
        username: p.username,
        display_name: p.display_name,
        avatar_path: p.avatar_path,
        verified: p.verified,
      })),
      last_message: preview?.lastMessage ?? null,
      unread_count: preview?.unread ?? 0,
    };
  });

  return NextResponse.json({
    conversations: result,
    next_cursor: nextCursorFor(conversations, limit),
  });
});

async function lastMessageFor(
  supabase: ServerClient,
  conversationId: string
): Promise<Message | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fromPostgrestError(error);
  return (data as Message | null) ?? null;
}

/**
 * Unread = messages from others with no read receipt from the viewer.
 * Candidate window is capped (see constant) so a huge backlog cannot blow
 * up the response; the count saturates at the cap.
 */
const UNREAD_WINDOW = 500;

async function unreadCountFor(
  supabase: ServerClient,
  userId: string,
  conversationId: string
): Promise<number> {
  const { data: candidates, error: candError } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .neq("sender_id", userId)
    .is("deleted_at", null)
    .limit(UNREAD_WINDOW + 1);
  if (candError) throw fromPostgrestError(candError);
  const ids = ((candidates ?? []) as { id: string }[]).map((m) => m.id);
  if (ids.length === 0) return 0;

  const { data: reads, error: readError } = await supabase
    .from("message_reads")
    .select("message_id")
    .eq("user_id", userId)
    .in("message_id", ids);
  if (readError) throw fromPostgrestError(readError);
  const readSet = new Set(
    ((reads ?? []) as { message_id: string }[]).map((r) => r.message_id)
  );
  const unread = ids.filter((id) => !readSet.has(id)).length;
  return Math.min(unread, UNREAD_WINDOW);
}

/**
 * Find-or-create a 1:1 conversation. The existing thread (exactly these two
 * participants, no more) is returned when present; otherwise a conversation
 * is created and both participants are added. Blocked users cannot start a
 * conversation with each other.
 */
export const POST = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  const parsed = conversationCreateSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);
  const targetId = parsed.data.user_id;

  if (targetId === user.id) {
    throw badRequest("You cannot start a conversation with yourself");
  }

  const supabase = await createClient();

  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id")
    .eq("id", targetId)
    .maybeSingle();
  if (targetError) throw fromPostgrestError(targetError);
  if (!target) throw notFound("User not found");

  const { data: blocked } = await supabase.rpc("blocked_between", {
    a: user.id,
    b: targetId,
  });
  if (blocked === true) {
    throw forbidden("You cannot message this user");
  }

  const existing = await findDirectConversation(supabase, user.id, targetId);
  if (existing) {
    return NextResponse.json({ conversation: existing, created: false });
  }

  // Create the conversation, then add participants one at a time: the RLS
  // bootstrap rule lets the creator insert themselves into a fresh
  // conversation, after which is_conversation_participant() permits adding
  // the peer.
  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .insert({})
    .select("*")
    .single();
  if (convError) throw fromPostgrestError(convError, "Could not create conversation");
  const convId = (conversation as Conversation).id;

  const { error: selfError } = await supabase
    .from("conversation_participants")
    .insert({ conversation_id: convId, user_id: user.id });
  if (selfError) throw fromPostgrestError(selfError, "Could not join conversation");

  const { error: peerError } = await supabase
    .from("conversation_participants")
    .insert({ conversation_id: convId, user_id: targetId });
  if (peerError) {
    // Roll back the half-created conversation rather than leaving an
    // orphaned empty thread.
    await adminClient.from("conversations").delete().eq("id", convId);
    throw fromPostgrestError(peerError, "Could not add participant");
  }

  return NextResponse.json(
    { conversation, created: true },
    { status: 201 }
  );
});

/**
 * Find the 1:1 conversation containing exactly these two users, or null.
 * (A duplicate created by a concurrent request is a known, tiny race; the
 * pair has no uniqueness constraint without a schema migration.)
 */
async function findDirectConversation(
  supabase: ServerClient,
  me: string,
  peer: string
): Promise<Conversation | null> {
  const { data: myRows, error: myError } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", me);
  if (myError) throw fromPostgrestError(myError);
  const myIds = ((myRows ?? []) as { conversation_id: string }[]).map(
    (r) => r.conversation_id
  );
  if (myIds.length === 0) return null;

  const { data: rows, error } = await supabase
    .from("conversation_participants")
    .select("conversation_id, user_id")
    .in("conversation_id", myIds)
    .in("user_id", [me, peer]);
  if (error) throw fromPostgrestError(error);

  const byConv = new Map<string, Set<string>>();
  for (const row of (rows ?? []) as { conversation_id: string; user_id: string }[]) {
    const set = byConv.get(row.conversation_id) ?? new Set<string>();
    set.add(row.user_id);
    byConv.set(row.conversation_id, set);
  }
  for (const [convId, members] of byConv) {
    if (members.size === 2 && members.has(me) && members.has(peer)) {
      const { data: conv, error: convError } = await supabase
        .from("conversations")
        .select("*")
        .eq("id", convId)
        .maybeSingle();
      if (convError) throw fromPostgrestError(convError);
      return (conv as Conversation | null) ?? null;
    }
  }
  return null;
}
