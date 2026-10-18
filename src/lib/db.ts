/**
 * Typed row shapes for the VYRO database, matching
 * supabase/migrations/*.sql exactly. Column names, nullability, and enums
 * below mirror the table definitions; if a migration changes, update this
 * file in lockstep.
 *
 * Counter strategy (binding, from migration 0001): follower / like / comment
 * counts are computed with COUNT(*) over indexed foreign keys. There are no
 * counter columns anywhere; the composite types below carry counts computed
 * at read time by the API layer.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./api-errors";

/** public.profiles (migration 0002) */
export interface Profile {
  id: string;
  /** Lowercase, 3-24 chars, [a-z0-9_], unique. */
  username: string;
  display_name: string | null;
  /** Max 160 chars. */
  bio: string | null;
  /** Storage path inside the avatars bucket: <user_id>/<uuid>.<ext>. */
  avatar_path: string | null;
  website_url: string | null;
  is_private: boolean;
  /** Admin-only flag; guarded by a DB trigger (non-admins cannot change it). */
  verified: boolean;
  created_at: string;
  updated_at: string;
}

export type VideoVisibility = "public" | "private";
export type VideoProcessingStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "removed";

/** public.videos (migration 0003) */
export interface Video {
  id: string;
  creator_id: string;
  /** Max 500 chars. */
  caption: string | null;
  /** Path inside the videos bucket: <creator_id>/<uuid>.<ext>. */
  storage_path: string;
  /** Path inside the thumbnails bucket: <creator_id>/<uuid>.<ext>. */
  thumbnail_path: string | null;
  duration_seconds: number | null;
  visibility: VideoVisibility;
  processing_status: VideoProcessingStatus;
  /** 'ok' when unflagged; any other value hides the video from feeds. */
  moderation_status: string;
  created_at: string;
  updated_at: string;
}

/** public.follows (migration 0004) */
export interface Follow {
  follower_id: string;
  followed_id: string;
  created_at: string;
}

/** public.video_likes (migration 0004) */
export interface VideoLike {
  user_id: string;
  video_id: string;
  created_at: string;
}

/** public.comments (migration 0004) */
export interface Comment {
  id: string;
  video_id: string;
  author_id: string;
  /** 1-500 chars. */
  body: string;
  created_at: string;
  updated_at: string;
}

/** public.hashtags (migration 0004). tag is normalized: lowercase, no '#'. */
export interface Hashtag {
  id: string;
  tag: string;
}

/** public.video_hashtags (migration 0004) */
export interface VideoHashtag {
  video_id: string;
  hashtag_id: string;
}

/** public.conversations (migration 0005) */
export interface Conversation {
  id: string;
  created_at: string;
  /** Bumped by a DB trigger on every new message. */
  updated_at: string;
}

/** public.conversation_participants (migration 0005) */
export interface ConversationParticipant {
  conversation_id: string;
  user_id: string;
  joined_at: string;
}

/** public.messages (migration 0005) */
export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  /** 1-2000 chars. */
  body: string;
  /** Path inside the chat-attachments bucket, or null for text-only. */
  attachment_path: string | null;
  created_at: string;
  edited_at: string | null;
  /** Soft delete; clients never hard-delete messages. */
  deleted_at: string | null;
}

/** public.message_reads (migration 0005). Append-only read receipts. */
export interface MessageRead {
  message_id: string;
  user_id: string;
  read_at: string;
}

export type NotificationType =
  | "follow"
  | "like"
  | "comment"
  | "message"
  | "report_update"
  | "moderation";

/** public.notifications (migration 0006). Written by DB triggers only. */
export interface Notification {
  id: string;
  recipient_id: string;
  actor_id: string | null;
  type: NotificationType;
  video_id: string | null;
  comment_id: string | null;
  conversation_id: string | null;
  read_at: string | null;
  created_at: string;
}

/** public.blocks (migration 0006). Directional block edges. */
export interface Block {
  blocker_id: string;
  blocked_id: string;
  created_at: string;
}

export type ReportTargetType = "user" | "video" | "comment";
export type ReportStatus = "open" | "reviewed" | "actioned" | "dismissed";

/** public.reports (migration 0006) */
export interface Report {
  id: string;
  reporter_id: string | null;
  target_type: ReportTargetType;
  target_id: string;
  /** 1-1000 chars. */
  reason: string;
  status: ReportStatus;
  created_at: string;
  reviewed_at: string | null;
}

// ---------------------------------------------------------------------------
// Composite read models (computed by the API layer, not stored).
// ---------------------------------------------------------------------------

/** A profile with follower/following/video counts computed via COUNT(*). */
export interface ProfileWithCounts extends Profile {
  follower_count: number;
  following_count: number;
  video_count: number;
  /** Relative to the requesting viewer; null when logged out. */
  is_followed_by_viewer: boolean | null;
  is_following_viewer: boolean | null;
  is_blocked_by_viewer: boolean | null;
}

/** A video with its creator and engagement state for the viewer. */
export interface VideoWithDetails extends Video {
  creator: Pick<
    Profile,
    "id" | "username" | "display_name" | "avatar_path" | "verified"
  >;
  like_count: number;
  comment_count: number;
  /** Null when the viewer is logged out. */
  liked_by_viewer: boolean | null;
}

/** A message with its sender's public identity. */
export interface MessageWithSender extends Message {
  sender: Pick<
    Profile,
    "id" | "username" | "display_name" | "avatar_path" | "verified"
  >;
}

/** A conversation row for the inbox list. */
export interface ConversationWithPreview extends Conversation {
  /** All participants except the viewer (for 1:1 threads this is the peer). */
  other_participants: Pick<
    Profile,
    "id" | "username" | "display_name" | "avatar_path" | "verified"
  >[];
  last_message: Message | null;
  unread_count: number;
}

/** A notification with the actor's public identity. */
export interface NotificationWithActor extends Notification {
  actor: Pick<
    Profile,
    "id" | "username" | "display_name" | "avatar_path" | "verified"
  > | null;
}

// ---------------------------------------------------------------------------
// Cursor pagination helpers.
//
// Cursors are base64url-encoded JSON of { created_at, id }. List endpoints
// order by (created_at DESC, id DESC) and filter to rows strictly older than
// the cursor, which keeps pagination stable under concurrent inserts.
// ---------------------------------------------------------------------------

export interface PageCursor {
  created_at: string;
  id: string;
}

/**
 * base64url without Node's Buffer (this project has no @types/node).
 * Cursor payloads are ISO timestamps and UUIDs (ASCII); the
 * encodeURIComponent round-trip keeps any future non-ASCII content safe.
 */
function toBase64Url(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(padded)));
}

export function encodeCursor(cursor: PageCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

export function decodeCursor(raw: string | null | undefined): PageCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(raw));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { created_at?: unknown }).created_at === "string" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return parsed as PageCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Storage path convention enforced by migration 0007:
 * "<user_id>/<uuid>.<ext>" -- exactly one folder level named after the
 * uploader's id, filename a UUID with an alphanumeric extension.
 */
export const STORAGE_PATH_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,10}$/;

export function isValidStoragePath(path: string): boolean {
  return STORAGE_PATH_RE.test(path);
}

/** The leading <user_id> folder of a storage path, or null if malformed. */
export function storagePathOwner(path: string): string | null {
  if (!isValidStoragePath(path)) return null;
  return path.split("/")[0] ?? null;
}

// ---------------------------------------------------------------------------
// Server-side read helpers shared by API routes.
// ---------------------------------------------------------------------------

/** Per-request read context: RLS-scoped client plus viewer identity. */
export interface ReadContext {
  /** Per-request client scoped to the viewer's JWT (RLS enforced). */
  userClient: SupabaseClient;
  /**
   * Service-role client. Used only after an explicit server-side
   * authorization check, in the narrow cases documented per call site.
   */
  adminClient: SupabaseClient;
  /** Null for anonymous viewers. */
  viewerId: string | null;
}

interface CountRow {
  count: number;
}

/**
 * API-level profile visibility rule (extends the DB's can_view_profile):
 * a profile is visible when it is public, the viewer owns it, the viewer is
 * an admin, or the viewer follows it -- and never across a block in either
 * direction. The follower exception is an API-layer rule from the route
 * contract; the DB helper alone does not grant followers access to private
 * profiles, so the follow edge is verified here first and the row is then
 * read with the admin client (the viewer's own client is RLS-blocked from
 * that row by design).
 */
export async function fetchVisibleProfiles(
  ctx: ReadContext,
  ids: string[]
): Promise<Map<string, Profile>> {
  const unique = [...new Set(ids)];
  const visible = new Map<string, Profile>();
  if (unique.length === 0) return visible;

  const { data } = await ctx.userClient
    .from("profiles")
    .select("*")
    .in("id", unique);
  for (const row of (data ?? []) as Profile[]) {
    visible.set(row.id, row);
  }

  const missing = unique.filter((id) => !visible.has(id));
  if (missing.length === 0 || !ctx.viewerId) return visible;

  // Follower override: confirm the follow edge with the viewer's RLS-scoped
  // client, confirm there is no block via the SECURITY DEFINER helper, and
  // only then read the rows with the admin client.
  const { data: followRows } = await ctx.userClient
    .from("follows")
    .select("followed_id")
    .eq("follower_id", ctx.viewerId)
    .in("followed_id", missing);
  const followed = new Set(
    ((followRows ?? []) as { followed_id: string }[]).map((r) => r.followed_id)
  );
  if (followed.size === 0) return visible;

  const blockChecks = await Promise.all(
    [...followed].map(async (id) => {
      const { data: blocked } = await ctx.userClient.rpc("blocked_between", {
        a: ctx.viewerId,
        b: id,
      });
      return { id, blocked: blocked === true };
    })
  );
  const allowed = blockChecks.filter((c) => !c.blocked).map((c) => c.id);
  if (allowed.length === 0) return visible;

  const { data: adminRows } = await ctx.adminClient
    .from("profiles")
    .select("*")
    .in("id", allowed);
  for (const row of (adminRows ?? []) as Profile[]) {
    visible.set(row.id, row);
  }
  return visible;
}

/**
 * Enrich videos with creator identity, like/comment counts, and the viewer's
 * like state.
 *
 * - Video rows are expected to already satisfy can_view_video (fetched
 *   through the viewer's RLS-scoped client).
 * - Like counts come from video_likes, whose reads require authentication
 *   (migration 0008), so anonymous viewers see like_count 0 and feeds rank
 *   on recency alone for them.
 * - Videos whose creator profile is not visible to the viewer under the API
 *   visibility rule are dropped, so every returned card links to a real,
 *   viewable profile.
 */
export async function enrichVideos(
  ctx: ReadContext,
  videos: Video[]
): Promise<VideoWithDetails[]> {
  if (videos.length === 0) return [];
  const ids = videos.map((v) => v.id);

  const [countRes, creators, likedRes] = await Promise.all([
    ctx.userClient
      .from("videos")
      .select("id, video_likes(count), comments(count)")
      .in("id", ids),
    fetchVisibleProfiles(ctx, videos.map((v) => v.creator_id)),
    ctx.viewerId
      ? ctx.userClient
          .from("video_likes")
          .select("video_id")
          .eq("user_id", ctx.viewerId)
          .in("video_id", ids)
      : Promise.resolve({ data: [] as { video_id: string }[] }),
  ]);

  const counts = new Map<string, { likes: number; comments: number }>();
  for (const row of (countRes.data ?? []) as {
    id: string;
    video_likes: CountRow[];
    comments: CountRow[];
  }[]) {
    counts.set(row.id, {
      likes: row.video_likes[0]?.count ?? 0,
      comments: row.comments[0]?.count ?? 0,
    });
  }
  const liked = new Set(
    ((likedRes.data ?? []) as { video_id: string }[]).map((r) => r.video_id)
  );

  const out: VideoWithDetails[] = [];
  for (const video of videos) {
    const creator = creators.get(video.creator_id);
    if (!creator) continue; // creator not visible: drop (documented above)
    const c = counts.get(video.id) ?? { likes: 0, comments: 0 };
    out.push({
      ...video,
      creator: {
        id: creator.id,
        username: creator.username,
        display_name: creator.display_name,
        avatar_path: creator.avatar_path,
        verified: creator.verified,
      },
      like_count: c.likes,
      comment_count: c.comments,
      liked_by_viewer: ctx.viewerId ? liked.has(video.id) : null,
    });
  }
  return out;
}

/** Parse ?cursor=&limit= query params; throws ApiError(400) on bad input. */
export function parsePagination(searchParams: URLSearchParams): {
  cursor: PageCursor | null;
  limit: number;
} {
  const rawLimit = searchParams.get("limit");
  let limit = 20;
  if (rawLimit !== null) {
    const n = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      throw new ApiError(400, "bad_request", "limit must be between 1 and 50");
    }
    limit = n;
  }
  const rawCursor = searchParams.get("cursor");
  if (rawCursor !== null) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor) {
      throw new ApiError(400, "bad_request", "Invalid cursor");
    }
    return { cursor, limit };
  }
  return { cursor: null, limit };
}

/**
 * Build a PostgREST OR filter selecting rows strictly older than the cursor.
 * Pair with .order(created_at, { ascending: false }).order(id, { ascending:
 * false }) for stable pagination under concurrent inserts.
 */
export function cursorFilter(
  cursor: PageCursor | null,
  createdAtColumn = "created_at",
  idColumn = "id"
): string | null {
  if (!cursor) return null;
  return (
    `${createdAtColumn}.lt.${cursor.created_at},` +
    `and(${createdAtColumn}.eq.${cursor.created_at},${idColumn}.lt.${cursor.id})`
  );
}

/**
 * Next cursor for a page of rows ordered by (created_at DESC, id DESC):
 * the last row's coordinates, or null when the page is not full.
 */
export function nextCursorFor<T extends { created_at: string; id: string }>(
  rows: T[],
  limit: number
): string | null {
  if (rows.length < limit || rows.length === 0) return null;
  const last = rows[rows.length - 1]!;
  return encodeCursor({ created_at: last.created_at, id: last.id });
}
