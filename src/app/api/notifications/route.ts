import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  validationError,
} from "@/lib/api-errors";
import { notificationsMarkReadSchema } from "@/lib/validation";
import {
  cursorFilter,
  fetchVisibleProfiles,
  nextCursorFor,
  parsePagination,
  type Notification,
  type ReadContext,
} from "@/lib/db";

/**
 * The viewer's notifications, newest first, cursor-paginated.
 * Notification rows are written by DB fan-out triggers (migration 0006);
 * this endpoint only reads them. Actors whose profile is not visible to the
 * viewer come back as actor: null.
 */
export const GET = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();
  const supabase = await createClient();
  const { cursor, limit } = parsePagination(new URL(request.url).searchParams);

  let query = supabase
    .from("notifications")
    .select("*")
    .eq("recipient_id", user.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  const filter = cursorFilter(cursor);
  if (filter) query = query.or(filter);

  const { data, error } = await query;
  if (error) throw fromPostgrestError(error);
  const notifications = (data ?? []) as Notification[];

  const { count: unreadCount, error: countError } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", user.id)
    .is("read_at", null);
  if (countError) throw fromPostgrestError(countError);

  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId: user.id };
  const actors = await fetchVisibleProfiles(
    ctx,
    notifications
      .map((n) => n.actor_id)
      .filter((id): id is string => id !== null)
  );

  return NextResponse.json({
    notifications: notifications.map((n) => {
      const actor = n.actor_id ? actors.get(n.actor_id) : undefined;
      return {
        ...n,
        actor: actor
          ? {
              id: actor.id,
              username: actor.username,
              display_name: actor.display_name,
              avatar_path: actor.avatar_path,
              verified: actor.verified,
            }
          : null,
      };
    }),
    unread_count: unreadCount ?? 0,
    next_cursor: nextCursorFor(notifications, limit),
  });
});

/**
 * Mark notifications as read ({ ids: [...] }).
 * Only read_at is written: the trg_notifications_guard_update trigger
 * (migration 0006) rejects any other column change for non-admins, and the
 * RLS policy scopes rows to the recipient.
 */
export const PATCH = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  const parsed = notificationsMarkReadSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_id", user.id)
    .in("id", parsed.data.ids)
    .select("id");
  if (error) throw fromPostgrestError(error);

  return NextResponse.json({ updated: (data ?? []).length });
});
