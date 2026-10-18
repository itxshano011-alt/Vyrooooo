
-- ==================== 0001_extensions_and_helpers.sql ====================
-- ============================================================================
-- VYRO migration 0001: extensions, admin list, and shared helper functions
-- Order dependency: FIRST migration. All later migrations depend on helpers
-- defined here (is_admin, blocked_between, can_view_profile, can_view_video,
-- touch_updated_at).
-- Purpose:
--   - Enable pg_trgm for username/display-name search and hashtag typeahead.
--   - Create the private admins table (seeded EMPTY) plus the is_admin()
--     SECURITY DEFINER gate. Admin rights NEVER come from a client-writable
--     column; only from this server-side list.
--   - Shared SECURITY DEFINER helpers used by RLS policies in 0008. They run
--     as the table owner so policy subqueries never recurse into RLS.
--   - touch_updated_at(): generic BEFORE UPDATE trigger for updated_at.
--
-- COUNTER STRATEGY (schema-wide, binding for backend/frontend):
--   Follower counts, like counts, comment counts, view-adjacent counts are
--   computed with COUNT(*) over indexed foreign keys. There are NO
--   trigger-maintained counter columns anywhere in this schema.
--   Rationale: always consistent (no drift bugs), no write amplification on
--   hot paths (a like is one row insert, not insert+update), and indexed
--   COUNT(*) is fast enough at VYRO's scale. If a feed ever needs sub-10ms
--   counts at very large scale, add a materialized counter table with a
--   backfill as a later migration -- not now.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- gen_random_uuid() is built into PostgreSQL 13+; no extension needed.

-- --------------------------------------------------------------------------
-- Private admin list. RLS is enabled with intentionally NO policies, so every
-- client role (anon, authenticated) is denied by default. Only postgres /
-- service_role and SECURITY DEFINER functions can read it.
-- Seeding: run as service_role (Supabase SQL editor):
--   INSERT INTO public.admins (user_id) VALUES ('<uuid>');
-- The table starts EMPTY, so is_admin() is false for everyone until seeded.
-- --------------------------------------------------------------------------
CREATE TABLE public.admins (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: deny-by-default for all client roles.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid());
$$;
COMMENT ON FUNCTION public.is_admin() IS
  'True when the caller is listed in the private admins table. Admin rights never come from a client-supplied role column.';

-- --------------------------------------------------------------------------
-- True when a block exists in either direction between two users.
-- SECURITY DEFINER so RLS policies can call it without recursive policy
-- evaluation. NULL-safe: returns false when either side is NULL (anon).
-- NOTE: references public.blocks, created in migration 0006. Function bodies
-- are validated at execution time, not creation time, so this is safe here.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.blocked_between(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a IS NOT NULL AND b IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.blocks
    WHERE (blocker_id = a AND blocked_id = b)
       OR (blocker_id = b AND blocked_id = a)
  );
$$;
COMMENT ON FUNCTION public.blocked_between(uuid, uuid) IS
  'True when a block exists in either direction between the two users.';

-- --------------------------------------------------------------------------
-- Central profile visibility rule, used by the profiles SELECT policy and
-- anywhere else profile visibility matters. A profile is viewable when it is
-- public, or the viewer owns it, or the viewer is an admin. Any block
-- relationship between viewer and profile owner hides the profile.
-- NOTE: references public.profiles, created in migration 0002.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_view_profile(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_profile_id
      AND (
        p.is_private = false
        OR p.id = auth.uid()
        OR public.is_admin()
      )
      AND NOT public.blocked_between(p.id, auth.uid())
  );
$$;
COMMENT ON FUNCTION public.can_view_profile(uuid) IS
  'Central profile visibility rule: public, owner, or admin; hidden across blocks.';

-- --------------------------------------------------------------------------
-- Central video visibility rule, used by the videos/comments/likes policies.
-- A video is viewable when it is public AND published AND unflagged, or the
-- viewer is the creator, or the viewer is an admin. Any block relationship
-- between viewer and creator hides the video.
-- NOTE: references public.videos, created in migration 0003.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_view_video(p_video_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.videos v
    WHERE v.id = p_video_id
      AND (
        (
          v.visibility = 'public'
          AND v.processing_status = 'published'
          AND v.moderation_status = 'ok'
        )
        OR v.creator_id = auth.uid()
        OR public.is_admin()
      )
      AND NOT public.blocked_between(v.creator_id, auth.uid())
  );
$$;
COMMENT ON FUNCTION public.can_view_video(uuid) IS
  'Central video visibility rule: public+published+ok, creator, or admin; hidden across blocks.';

-- --------------------------------------------------------------------------
-- Generic updated_at auto-touch for BEFORE UPDATE triggers.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.touch_updated_at() IS
  'BEFORE UPDATE trigger: sets NEW.updated_at = now().';

-- ==================== 0002_profiles.sql ====================
-- ============================================================================
-- VYRO migration 0002: profiles
-- Order dependency: runs after 0001 (uses touch_updated_at, is_admin).
-- Purpose:
--   - profiles table: one row per auth.users id, public identity for VYRO.
--   - Username is lowercase-only, 3-24 chars, [a-z0-9_], enforced by CHECK.
--   - Auto-provision a profile on signup (handle_new_user trigger on
--     auth.users) with a unique-username fallback loop.
--   - Guard trigger: verified flag and id are immutable for non-admins
--     (defense in depth behind RLS).
--   - Indexes: btree on created_at; trigram GIN on username and display_name
--     for search-as-you-type.
-- RLS: enabled here; policies are defined centrally in 0008.
-- ============================================================================

CREATE TABLE public.profiles (
  id           uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username     text        NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text,
  bio          text        CHECK (bio IS NULL OR char_length(bio) <= 160),
  avatar_path  text,
  website_url  text,
  is_private   boolean     NOT NULL DEFAULT false,
  verified     boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.profiles IS 'Public identity for each auth user. Counts (followers etc.) are computed via COUNT(*); see 0001 counter strategy.';
COMMENT ON COLUMN public.profiles.avatar_path IS 'Storage path inside the avatars bucket: <user_id>/<uuid>.<ext>.';

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE INDEX profiles_created_at_idx ON public.profiles (created_at DESC);
CREATE INDEX profiles_username_trgm_idx ON public.profiles USING gin (username gin_trgm_ops);
CREATE INDEX profiles_display_name_trgm_idx ON public.profiles USING gin (display_name gin_trgm_ops);

CREATE TRIGGER trg_profiles_touch_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- --------------------------------------------------------------------------
-- Guard: only an admin (or service_role pipeline) may change the verified
-- flag, and the primary key is immutable. This sits behind RLS as defense in
-- depth: even if an UPDATE policy were ever widened, privilege escalation is
-- still blocked here.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_privileged_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    IF NEW.verified IS DISTINCT FROM OLD.verified THEN
      RAISE EXCEPTION 'verified flag can only be changed by an admin';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'profile id is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_guard_privileged
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileged_fields();

-- --------------------------------------------------------------------------
-- Auto-provision a profile row whenever a user signs up. Derives a lowercase
-- username from the signup metadata (or the email local part), sanitizes it
-- to [a-z0-9_], and appends _1, _2, ... on collision so the UNIQUE and CHECK
-- constraints always hold. Runs SECURITY DEFINER so it works during signup
-- regardless of client RLS.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  base_name  text;
  final_name text;
  n          integer := 0;
BEGIN
  base_name := lower(regexp_replace(
    coalesce(
      NEW.raw_user_meta_data ->> 'username',
      split_part(NEW.email, '@', 1)
    ),
    '[^a-z0-9_]', '', 'g'
  ));
  base_name := substring(base_name from 1 for 20);

  IF base_name IS NULL OR char_length(base_name) < 3 THEN
    base_name := 'user_' || substring(replace(NEW.id::text, '-', '') from 1 for 8);
  END IF;

  final_name := base_name;
  LOOP
    BEGIN
      INSERT INTO public.profiles (id, username, display_name)
      VALUES (
        NEW.id,
        final_name,
        coalesce(NULLIF(NEW.raw_user_meta_data ->> 'display_name', ''), final_name)
      );
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      n := n + 1;
      final_name := substring(base_name from 1 for 20) || '_' || n::text;
      IF char_length(final_name) > 24 THEN
        final_name := substring(base_name from 1 for 18) || '_' || n::text;
      END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ==================== 0003_videos.sql ====================
-- ============================================================================
-- VYRO migration 0003: videos
-- Order dependency: runs after 0002 (references profiles).
-- Purpose:
--   - videos table: short-video posts with storage paths, visibility,
--     processing lifecycle, and moderation state.
--   - processing_status lifecycle: pending -> processing -> published, or
--     failed / removed. New uploads start as 'published' by default so a
--     client-only flow works; a real upload pipeline (Edge Function /
--     service_role) should insert as 'pending' and promote it.
--   - Guard trigger: processing_status, moderation_status and creator_id are
--     immutable for non-admin, non-service_role callers. Creators cannot
--     mark their own video published or clear a moderation flag.
--   - Indexes: FK btree on creator_id, created_at ordering, creator feed
--     composite, and a partial index for the hot public-feed query.
-- RLS: enabled here; policies are defined centrally in 0008.
-- ============================================================================

CREATE TABLE public.videos (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  caption           text        CHECK (caption IS NULL OR char_length(caption) <= 500),
  storage_path      text        NOT NULL,
  thumbnail_path    text,
  duration_seconds  integer     CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  visibility        text        NOT NULL DEFAULT 'public'
                                CHECK (visibility IN ('public', 'private')),
  processing_status text        NOT NULL DEFAULT 'published'
                                CHECK (processing_status IN ('pending', 'processing', 'published', 'failed', 'removed')),
  moderation_status text        NOT NULL DEFAULT 'ok',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.videos IS 'Short-video posts. Like/comment counts are computed via COUNT(*); see 0001 counter strategy.';
COMMENT ON COLUMN public.videos.storage_path IS 'Path inside the videos bucket: <creator_id>/<uuid>.<ext>.';
COMMENT ON COLUMN public.videos.thumbnail_path IS 'Path inside the thumbnails bucket: <creator_id>/<uuid>.<ext>.';

ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;

CREATE INDEX videos_creator_id_idx ON public.videos (creator_id);
CREATE INDEX videos_created_at_idx ON public.videos (created_at DESC);
CREATE INDEX videos_creator_feed_idx ON public.videos (creator_id, created_at DESC);
-- Hot path: global public feed of viewable videos.
CREATE INDEX videos_public_feed_idx ON public.videos (created_at DESC)
  WHERE visibility = 'public' AND processing_status = 'published' AND moderation_status = 'ok';

CREATE TRIGGER trg_videos_touch_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- --------------------------------------------------------------------------
-- Guard: only the platform pipeline (service_role) or an admin may move a
-- video through processing/moderation states or reassign its creator. This
-- is defense in depth behind RLS: the RLS UPDATE policy already limits who
-- can update, this limits WHAT they can change.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_video_status_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    IF NEW.processing_status IS DISTINCT FROM OLD.processing_status
       OR NEW.moderation_status IS DISTINCT FROM OLD.moderation_status THEN
      RAISE EXCEPTION 'processing_status and moderation_status can only be changed by the platform or an admin';
    END IF;
    IF NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
      RAISE EXCEPTION 'video creator_id is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_videos_guard_status
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.guard_video_status_fields();

-- ==================== 0004_social.sql ====================
-- ============================================================================
-- VYRO migration 0004: social graph (follows, likes, comments, hashtags)
-- Order dependency: runs after 0003 (references profiles, videos).
-- Purpose:
--   - follows: directed follow edges, self-follow impossible by CHECK.
--   - video_likes: like edges; uniqueness per (user, video) via PK.
--   - comments: 1..500 char bodies on videos.
--   - hashtags + video_hashtags: normalized lowercase tags without '#',
--     many-to-many to videos. Tag extraction from captions is done by the
--     application / Edge Function layer, not by DB triggers.
-- Counter strategy: follower / following / like / comment counts are plain
-- COUNT(*) queries over the indexes below (see 0001). No counter columns.
-- RLS: enabled here on all five tables; policies are defined in 0008.
-- ============================================================================

-- --------------------------------------------------------------------------
-- follows
-- --------------------------------------------------------------------------
CREATE TABLE public.follows (
  follower_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followed_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

CREATE INDEX follows_followed_id_idx ON public.follows (followed_id);
CREATE INDEX follows_follower_created_idx ON public.follows (follower_id, created_at DESC);

-- --------------------------------------------------------------------------
-- video_likes
-- --------------------------------------------------------------------------
CREATE TABLE public.video_likes (
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  video_id   uuid        NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);
ALTER TABLE public.video_likes ENABLE ROW LEVEL SECURITY;

CREATE INDEX video_likes_video_id_idx ON public.video_likes (video_id);
CREATE INDEX video_likes_video_created_idx ON public.video_likes (video_id, created_at DESC);

-- --------------------------------------------------------------------------
-- comments
-- --------------------------------------------------------------------------
CREATE TABLE public.comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   uuid        NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  author_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

CREATE INDEX comments_video_created_idx ON public.comments (video_id, created_at DESC);
CREATE INDEX comments_author_id_idx ON public.comments (author_id);

CREATE TRIGGER trg_comments_touch_updated_at
  BEFORE UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- --------------------------------------------------------------------------
-- hashtags (normalized: lowercase, no leading '#')
-- --------------------------------------------------------------------------
CREATE TABLE public.hashtags (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag  text NOT NULL UNIQUE CHECK (tag ~ '^[a-z0-9_]{1,64}$')
);
COMMENT ON COLUMN public.hashtags.tag IS 'Normalized tag: lowercase, no leading #, 1-64 chars of [a-z0-9_].';
ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;

CREATE INDEX hashtags_tag_trgm_idx ON public.hashtags USING gin (tag gin_trgm_ops);

-- --------------------------------------------------------------------------
-- video_hashtags (many-to-many)
-- --------------------------------------------------------------------------
CREATE TABLE public.video_hashtags (
  video_id   uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, hashtag_id)
);
ALTER TABLE public.video_hashtags ENABLE ROW LEVEL SECURITY;

CREATE INDEX video_hashtags_hashtag_id_idx ON public.video_hashtags (hashtag_id);

-- ==================== 0005_messaging.sql ====================
-- ============================================================================
-- VYRO migration 0005: messaging (conversations, participants, messages,
-- read receipts)
-- Order dependency: runs after 0004 (references profiles).
-- Purpose:
--   - conversations: 1:1 and group threads; updated_at bumps on each new
--     message so the inbox can order by recency.
--   - conversation_participants: membership; PK prevents duplicate joins.
--   - messages: 1..2000 char bodies, optional attachment_path, edited_at for
--     edits, deleted_at for soft deletes (no hard delete via client RLS).
--   - message_reads: per-user read receipts, append-only.
--   - is_conversation_participant(): SECURITY DEFINER membership check used
--     by RLS policies in 0008 and the chat-attachments storage policy in
--     0007. SECURITY DEFINER avoids recursive RLS evaluation on
--     conversation_participants.
--   - Guard trigger: sender_id and conversation_id are immutable on messages.
-- RLS: enabled here on all four tables; policies are defined in 0008.
-- ============================================================================

CREATE TABLE public.conversations (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE INDEX conversations_updated_at_idx ON public.conversations (updated_at DESC);

CREATE TABLE public.conversation_participants (
  conversation_id uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

CREATE INDEX conversation_participants_user_id_idx
  ON public.conversation_participants (user_id);

CREATE TABLE public.messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body            text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  attachment_path text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz
);
COMMENT ON COLUMN public.messages.attachment_path IS 'Path inside the chat-attachments bucket: <sender_id>/<uuid>.<ext>. NULL when text-only.';
COMMENT ON COLUMN public.messages.deleted_at IS 'Soft delete. Clients never hard-delete messages via RLS.';
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE INDEX messages_conversation_created_idx
  ON public.messages (conversation_id, created_at DESC);
CREATE INDEX messages_sender_id_idx ON public.messages (sender_id);

CREATE TABLE public.message_reads (
  message_id uuid        NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
COMMENT ON TABLE public.message_reads IS 'Read receipts. Append-only: no UPDATE or DELETE via client RLS.';
ALTER TABLE public.message_reads ENABLE ROW LEVEL SECURITY;

CREATE INDEX message_reads_user_id_idx ON public.message_reads (user_id);

-- --------------------------------------------------------------------------
-- SECURITY DEFINER membership check. Used by messaging RLS policies and the
-- chat-attachments storage policy. Must stay SECURITY DEFINER: a plain
-- function (or inline subquery) on conversation_participants would recurse
-- through RLS.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_conversation_participant(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id AND user_id = auth.uid()
  );
$$;
COMMENT ON FUNCTION public.is_conversation_participant(uuid) IS
  'True when the caller is a participant of the conversation. SECURITY DEFINER to avoid recursive RLS.';

-- --------------------------------------------------------------------------
-- Keep conversation ordering fresh: bump updated_at whenever a message lands.
-- SECURITY DEFINER so it works regardless of the sender''s UPDATE rights on
-- conversations.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_conversation_on_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bump_conversation_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_conversation_on_message();

-- --------------------------------------------------------------------------
-- Guard: a message can never be re-attributed to another sender or moved to
-- another conversation (defense in depth behind RLS).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_message_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    IF NEW.sender_id IS DISTINCT FROM OLD.sender_id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
      RAISE EXCEPTION 'message sender and conversation are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_messages_guard_immutable
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_immutable_fields();

-- ==================== 0006_notifications_blocks_reports.sql ====================
-- ============================================================================
-- VYRO migration 0006: notifications, blocks, reports
-- Order dependency: runs after 0005 (references profiles, videos, comments,
-- conversations, follows, video_likes, messages, conversation_participants).
-- Purpose:
--   - notifications: server-side event inbox. There is intentionally NO
--     client INSERT policy (see 0008): rows are written only by the fan-out
--     triggers below and by service_role (Edge Functions). Clients can only
--     read their own, mark read_at, and delete their own.
--   - blocks: directional block edges; self-block impossible by CHECK.
--   - reports: user reports against users/videos/comments with a moderation
--     workflow status (open -> reviewed -> actioned / dismissed).
--   - Fan-out triggers notify_on_follow / notify_on_like /
--     notify_on_comment / notify_on_message insert notifications
--     SECURITY DEFINER, skipping self-actions and blocked relationships.
--   - Guard trigger: non-admins may only change read_at on notifications.
-- RLS: enabled here on all three tables; policies are defined in 0008.
-- ============================================================================

-- --------------------------------------------------------------------------
-- notifications
-- --------------------------------------------------------------------------
CREATE TABLE public.notifications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  type            text        NOT NULL CHECK (type IN ('follow', 'like', 'comment', 'message', 'report_update', 'moderation')),
  video_id        uuid        REFERENCES public.videos(id) ON DELETE CASCADE,
  comment_id      uuid        REFERENCES public.comments(id) ON DELETE CASCADE,
  conversation_id uuid        REFERENCES public.conversations(id) ON DELETE CASCADE,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.notifications IS 'Server-side event inbox. Written by DB triggers / service_role only; never by clients directly.';
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE INDEX notifications_recipient_created_idx
  ON public.notifications (recipient_id, created_at DESC);
CREATE INDEX notifications_recipient_unread_idx
  ON public.notifications (recipient_id, created_at DESC)
  WHERE read_at IS NULL;

-- --------------------------------------------------------------------------
-- blocks
-- --------------------------------------------------------------------------
CREATE TABLE public.blocks (
  blocker_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

CREATE INDEX blocks_blocked_id_idx ON public.blocks (blocked_id);

-- --------------------------------------------------------------------------
-- reports
-- --------------------------------------------------------------------------
CREATE TABLE public.reports (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_type text        NOT NULL CHECK (target_type IN ('user', 'video', 'comment')),
  target_id   uuid        NOT NULL,
  reason      text        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  status      text        NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'reviewed', 'actioned', 'dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
COMMENT ON TABLE public.reports IS 'User reports. Status workflow is managed by admins; reporters can only create and view their own.';
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

CREATE INDEX reports_status_idx ON public.reports (status);
CREATE INDEX reports_target_idx ON public.reports (target_type, target_id);

-- --------------------------------------------------------------------------
-- Guard: non-admin callers may only flip read_at on a notification. Every
-- other column is immutable through client RLS (defense in depth: even the
-- recipient cannot forge actor/type/target references).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_notification_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    IF NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.video_id IS DISTINCT FROM OLD.video_id
       OR NEW.comment_id IS DISTINCT FROM OLD.comment_id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'only read_at may be updated on notifications';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notifications_guard_update
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.guard_notification_update();

-- --------------------------------------------------------------------------
-- Notification fan-out. All four run SECURITY DEFINER so they can insert into
-- notifications (which has no client INSERT policy). Each skips self-actions
-- and any pair with a block relationship, so blocked users never generate
-- notifications for each other.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_on_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.blocked_between(NEW.follower_id, NEW.followed_id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications (recipient_id, actor_id, type)
  VALUES (NEW.followed_id, NEW.follower_id, 'follow');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_on_follow
  AFTER INSERT ON public.follows
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_follow();

CREATE OR REPLACE FUNCTION public.notify_on_like()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_creator uuid;
BEGIN
  SELECT creator_id INTO v_creator FROM public.videos WHERE id = NEW.video_id;
  IF v_creator IS NULL OR v_creator = NEW.user_id THEN
    RETURN NEW; -- no video, or liking your own video: no notification
  END IF;
  IF public.blocked_between(NEW.user_id, v_creator) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications (recipient_id, actor_id, type, video_id)
  VALUES (v_creator, NEW.user_id, 'like', NEW.video_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_on_like
  AFTER INSERT ON public.video_likes
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_like();

CREATE OR REPLACE FUNCTION public.notify_on_comment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_creator uuid;
BEGIN
  SELECT creator_id INTO v_creator FROM public.videos WHERE id = NEW.video_id;
  IF v_creator IS NULL OR v_creator = NEW.author_id THEN
    RETURN NEW; -- no video, or commenting on your own video: no notification
  END IF;
  IF public.blocked_between(NEW.author_id, v_creator) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications (recipient_id, actor_id, type, video_id, comment_id)
  VALUES (v_creator, NEW.author_id, 'comment', NEW.video_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_on_comment
  AFTER INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_comment();

CREATE OR REPLACE FUNCTION public.notify_on_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.notifications (recipient_id, actor_id, type, conversation_id)
  SELECT cp.user_id, NEW.sender_id, 'message', NEW.conversation_id
  FROM public.conversation_participants cp
  WHERE cp.conversation_id = NEW.conversation_id
    AND cp.user_id <> NEW.sender_id
    AND NOT public.blocked_between(cp.user_id, NEW.sender_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_message();

-- ==================== 0007_storage.sql ====================
-- ============================================================================
-- VYRO migration 0007: storage buckets and storage RLS policies
-- Order dependency: runs after 0006 (chat-attachments read policy calls
-- public.is_conversation_participant from 0005 and reads public.messages).
-- Purpose:
--   - Create buckets: videos (private), thumbnails (public), avatars
--     (public), chat-attachments (private).
--   - Storage RLS on storage.objects. Path convention enforced on WRITE:
--     every file must live at "<auth.uid()>/<uuid>.<ext>" -- exactly one
--     folder level named after the uploader's user id, filename a UUID with
--     an alphanumeric extension. The application MUST upload with that key
--     shape or the insert is rejected.
--   - Read rules:
--       videos:           owner or admin only (private bucket).
--       thumbnails:       public read; owner write.
--       avatars:          public read; owner write.
--       chat-attachments: owner, admin, or a participant of a conversation
--                         that has a non-deleted message referencing the file.
-- NOTE: this migration assumes the Supabase storage schema exists (it does
-- on every Supabase project) and that RLS is already enabled on
-- storage.objects (Supabase default). Policies below are additive.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('videos',           'videos',           false),
  ('thumbnails',       'thumbnails',       true),
  ('avatars',          'avatars',          true),
  ('chat-attachments', 'chat-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- videos bucket (private): owner read/write, admin read/write.
-- --------------------------------------------------------------------------

CREATE POLICY "videos: owner or admin can read"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'videos'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
);

CREATE POLICY "videos: owner can upload to own prefix"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'videos'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

CREATE POLICY "videos: owner or admin can update"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'videos'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
)
WITH CHECK (
  bucket_id = 'videos'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

CREATE POLICY "videos: owner or admin can delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'videos'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
);

-- --------------------------------------------------------------------------
-- thumbnails bucket (public read): anyone can read; only the owner path may
-- be written.
-- --------------------------------------------------------------------------

CREATE POLICY "thumbnails: public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'thumbnails');

CREATE POLICY "thumbnails: owner can upload to own prefix"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'thumbnails'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

CREATE POLICY "thumbnails: owner or admin can update"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'thumbnails'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
)
WITH CHECK (
  bucket_id = 'thumbnails'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

CREATE POLICY "thumbnails: owner or admin can delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'thumbnails'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
);

-- --------------------------------------------------------------------------
-- avatars bucket (public read): anyone can read; only the owner path may be
-- written.
-- --------------------------------------------------------------------------

CREATE POLICY "avatars: public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

CREATE POLICY "avatars: owner can upload to own prefix"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

CREATE POLICY "avatars: owner or admin can update"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
)
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

CREATE POLICY "avatars: owner or admin can delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
);

-- --------------------------------------------------------------------------
-- chat-attachments bucket (private): owner write; read by the owner, an
-- admin, or any participant of a conversation containing a non-deleted
-- message that references the file. This keeps attachments out of reach of
-- non-participants even though the bucket is private and URLs are signed.
-- --------------------------------------------------------------------------

CREATE POLICY "chat-attachments: owner, admin or participant can read"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'chat-attachments'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.attachment_path = storage.objects.name
        AND m.deleted_at IS NULL
        AND public.is_conversation_participant(m.conversation_id)
      -- NOTE: m.* is read through the messages RLS policy here, so a caller
      -- only matches messages they are already allowed to see.
    )
  )
);

CREATE POLICY "chat-attachments: owner can upload to own prefix"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'chat-attachments'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

CREATE POLICY "chat-attachments: owner or admin can update"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'chat-attachments'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
)
WITH CHECK (
  bucket_id = 'chat-attachments'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

CREATE POLICY "chat-attachments: owner or admin can delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'chat-attachments'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
);

-- ==================== 0008_rls_policies.sql ====================
-- ============================================================================
-- VYRO migration 0008: row level security policies for all tables
-- Order dependency: LAST migration. Runs after 0001-0007; every table and
-- every helper function referenced here already exists.
-- Purpose: define every client-facing access rule in one place. All tables
-- had RLS ENABLED in their own migration with zero policies (deny-by-default
-- until this file runs).
--
-- Policy naming: <table>_<action>_<rule>, e.g. videos_select_visible.
-- Conventions used throughout:
--   - Public reads (profiles, videos, comments, hashtags) allow anon too, so
--     the logged-out feed and search work.
--   - Writes are TO authenticated only (anon can insert nothing).
--   - Visibility logic lives in the SECURITY DEFINER helpers from 0001
--     (can_view_profile, can_view_video, blocked_between) and 0005
--     (is_conversation_participant) so rules cannot drift between tables.
--   - Admin override via public.is_admin() (server-side admins table, 0001).
--   - service_role bypasses RLS entirely (Supabase default); backend jobs
--     and Edge Functions use it.
-- Deliberate gaps (documented, not oversights):
--   - profiles: no DELETE policy. Account deletion goes through auth.users,
--     which cascades to profiles and everything below it.
--   - messages: no DELETE policy. Clients soft-delete via deleted_at; hard
--     delete is service_role only.
--   - message_reads: no UPDATE/DELETE policies. Read receipts are append-only.
--   - notifications: no client INSERT policy. Written only by the DB fan-out
--     triggers (0006) and service_role; clients cannot forge notifications.
--   - blocks: no UPDATE policy. Delete + re-insert to change a block.
--   - admins: RLS enabled, zero policies. Only SECURITY DEFINER functions and
--     service_role can read it.
-- ============================================================================

-- ============================================================================
-- profiles
-- ============================================================================

-- Anyone (even logged out) can read viewable profiles: public accounts, plus
-- your own, plus everything for admins. Blocked relationships hide profiles
-- in both directions. See can_view_profile() in 0001.
CREATE POLICY profiles_select_public
ON public.profiles FOR SELECT
USING (public.can_view_profile(id));

-- A signed-in user can create exactly their own profile row (id must equal
-- their auth id). Signup normally goes through the handle_new_user trigger.
CREATE POLICY profiles_insert_self
ON public.profiles FOR INSERT TO authenticated
WITH CHECK (id = auth.uid());

-- Owners edit their own row only. The verified flag and id are additionally
-- guarded by the trg_profiles_guard_privileged trigger (0002).
CREATE POLICY profiles_update_self
ON public.profiles FOR UPDATE TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- ============================================================================
-- videos
-- ============================================================================

-- Anyone can read viewable videos: public + published + unflagged, or your
-- own, or everything for admins. Blocked creators are hidden. Feeds and
-- search build on this.
CREATE POLICY videos_select_visible
ON public.videos FOR SELECT
USING (public.can_view_video(id));

-- Creators insert only as themselves.
CREATE POLICY videos_insert_own
ON public.videos FOR INSERT TO authenticated
WITH CHECK (creator_id = auth.uid());

-- Creators edit their own videos (caption, visibility, thumbnail). Admins can
-- edit any video (e.g. moderation caption removal). The
-- trg_videos_guard_status trigger (0003) separately prevents non-admins from
-- touching processing_status / moderation_status / creator_id.
CREATE POLICY videos_update_creator
ON public.videos FOR UPDATE TO authenticated
USING (creator_id = auth.uid() OR public.is_admin())
WITH CHECK (creator_id = auth.uid() OR public.is_admin());

-- Creators delete their own videos; admins can remove any video (takedowns).
CREATE POLICY videos_delete_creator
ON public.videos FOR DELETE TO authenticated
USING (creator_id = auth.uid() OR public.is_admin());

-- ============================================================================
-- follows
-- ============================================================================

-- Authenticated users can read follow edges, except edges involving someone
-- they have a block relationship with (either direction).
CREATE POLICY follows_select_all
ON public.follows FOR SELECT TO authenticated
USING (
  NOT public.blocked_between(follower_id, auth.uid())
  AND NOT public.blocked_between(followed_id, auth.uid())
);

-- You can only follow as yourself, and never across a block (blocked users
-- cannot follow you, and you cannot follow someone you blocked).
CREATE POLICY follows_insert_self
ON public.follows FOR INSERT TO authenticated
WITH CHECK (
  follower_id = auth.uid()
  AND NOT public.blocked_between(follower_id, followed_id)
);

-- You can only unfollow yourself.
CREATE POLICY follows_delete_self
ON public.follows FOR DELETE TO authenticated
USING (follower_id = auth.uid());

-- ============================================================================
-- video_likes
-- ============================================================================

-- Authenticated users can read likes (needed for counts and liked-state).
CREATE POLICY video_likes_select_all
ON public.video_likes FOR SELECT TO authenticated
USING (true);

-- You can only like as yourself, and only videos you are allowed to view.
-- Uniqueness of (user_id, video_id) is enforced by the primary key.
CREATE POLICY video_likes_insert_own
ON public.video_likes FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND public.can_view_video(video_id));

-- You can only unlike your own likes.
CREATE POLICY video_likes_delete_own
ON public.video_likes FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- ============================================================================
-- comments
-- ============================================================================

-- Anyone can read comments on viewable videos.
CREATE POLICY comments_select_visible
ON public.comments FOR SELECT
USING (public.can_view_video(video_id));

-- You can only comment as yourself, and only on videos you can view.
CREATE POLICY comments_insert_own
ON public.comments FOR INSERT TO authenticated
WITH CHECK (author_id = auth.uid() AND public.can_view_video(video_id));

-- Authors edit their own comments (body only in practice; the app should send
-- body + let the trigger bump updated_at).
CREATE POLICY comments_update_author
ON public.comments FOR UPDATE TO authenticated
USING (author_id = auth.uid())
WITH CHECK (author_id = auth.uid());

-- Delete: the author, the video creator (moderate your own video), or admin.
CREATE POLICY comments_delete_perms
ON public.comments FOR DELETE TO authenticated
USING (
  author_id = auth.uid()
  OR public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.videos v
    WHERE v.id = comments.video_id AND v.creator_id = auth.uid()
  )
);

-- ============================================================================
-- hashtags
-- ============================================================================

-- Tags are public discovery data, readable by everyone including anon.
CREATE POLICY hashtags_select_public
ON public.hashtags FOR SELECT
USING (true);

-- Any signed-in user may introduce a tag (normally done by the app when a
-- caption with #tags is posted).
CREATE POLICY hashtags_insert_auth
ON public.hashtags FOR INSERT TO authenticated
WITH CHECK (true);

-- Only admins rename or remove tags.
CREATE POLICY hashtags_update_admin
ON public.hashtags FOR UPDATE TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY hashtags_delete_admin
ON public.hashtags FOR DELETE TO authenticated
USING (public.is_admin());

-- ============================================================================
-- video_hashtags
-- ============================================================================

-- Public mapping, readable by everyone.
CREATE POLICY video_hashtags_select_public
ON public.video_hashtags FOR SELECT
USING (true);

-- Only the video's creator (or admin) may tag/untag a video.
CREATE POLICY video_hashtags_insert_creator
ON public.video_hashtags FOR INSERT TO authenticated
WITH CHECK (
  public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.videos v
    WHERE v.id = video_hashtags.video_id AND v.creator_id = auth.uid()
  )
);

CREATE POLICY video_hashtags_delete_creator
ON public.video_hashtags FOR DELETE TO authenticated
USING (
  public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.videos v
    WHERE v.id = video_hashtags.video_id AND v.creator_id = auth.uid()
  )
);

-- ============================================================================
-- conversations
-- ============================================================================

-- Participants (and admins) can see their conversations.
CREATE POLICY conversations_select_participant
ON public.conversations FOR SELECT TO authenticated
USING (public.is_conversation_participant(id) OR public.is_admin());

-- Any signed-in user can start a conversation; they add themselves as the
-- first participant via conversation_participants (see its INSERT policy).
CREATE POLICY conversations_insert_auth
ON public.conversations FOR INSERT TO authenticated
WITH CHECK (true);

-- Participants may touch the row (updated_at is normally maintained by the
-- trg_bump_conversation_on_message trigger); admins unrestricted.
CREATE POLICY conversations_update_participant
ON public.conversations FOR UPDATE TO authenticated
USING (public.is_conversation_participant(id) OR public.is_admin())
WITH CHECK (public.is_conversation_participant(id) OR public.is_admin());

-- Only admins delete whole conversations via the API; users leave via
-- conversation_participants instead.
CREATE POLICY conversations_delete_admin
ON public.conversations FOR DELETE TO authenticated
USING (public.is_admin());

-- ============================================================================
-- conversation_participants
-- ============================================================================

-- Participants (and admins) can see who is in their conversations.
CREATE POLICY conversation_participants_select_participant
ON public.conversation_participants FOR SELECT TO authenticated
USING (
  public.is_conversation_participant(conversation_id)
  OR public.is_admin()
);

-- Join rules:
--   * admins: anything;
--   * bootstrapping: the conversation creator inserts THEMSELVES as the first
--     participant of a fresh conversation;
--   * otherwise: an existing participant adds new members (group chats).
-- Nobody can be added across a block relationship in either direction.
CREATE POLICY conversation_participants_insert_managed
ON public.conversation_participants FOR INSERT TO authenticated
WITH CHECK (
  NOT public.blocked_between(user_id, auth.uid())
  AND (
    public.is_admin()
    OR (
      user_id = auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.conversation_participants p
        WHERE p.conversation_id = conversation_participants.conversation_id
      )
    )
    OR public.is_conversation_participant(conversation_participants.conversation_id)
  )
);

-- Leave a conversation (delete your own row), or admin removal.
CREATE POLICY conversation_participants_delete_self
ON public.conversation_participants FOR DELETE TO authenticated
USING (user_id = auth.uid() OR public.is_admin());

-- ============================================================================
-- messages
-- ============================================================================

-- Participants (and admins) can read non-deleted messages in their
-- conversations. Soft-deleted messages are invisible to everyone via RLS.
CREATE POLICY messages_select_participant
ON public.messages FOR SELECT TO authenticated
USING (
  deleted_at IS NULL
  AND (
    public.is_conversation_participant(conversation_id)
    OR public.is_admin()
  )
);

-- Send rules: you send as yourself, you must be a participant, and you cannot
-- message into a conversation with anyone you have a block relationship with.
CREATE POLICY messages_insert_sender
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid()
  AND public.is_conversation_participant(conversation_id)
  AND NOT EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.conversation_id = messages.conversation_id
      AND cp.user_id <> auth.uid()
      AND public.blocked_between(cp.user_id, auth.uid())
  )
);

-- Edit your own non-deleted messages (sets edited_at in the app). The
-- trg_messages_guard_immutable trigger (0005) keeps sender/conversation
-- immutable; once deleted_at is set the row can no longer be updated.
CREATE POLICY messages_update_sender
ON public.messages FOR UPDATE TO authenticated
USING (sender_id = auth.uid() AND deleted_at IS NULL)
WITH CHECK (sender_id = auth.uid());

-- No DELETE policy: clients soft-delete via deleted_at; hard delete is
-- service_role only.

-- ============================================================================
-- message_reads
-- ============================================================================

-- You can see your own receipts; participants of the conversation can see
-- receipts on its messages (for "seen" ticks); admins see all.
CREATE POLICY message_reads_select_visible
ON public.message_reads FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.id = message_reads.message_id
      AND public.is_conversation_participant(m.conversation_id)
  )
);

-- You can only mark messages as read for yourself, in conversations you
-- participate in.
CREATE POLICY message_reads_insert_own
ON public.message_reads FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.id = message_reads.message_id
      AND public.is_conversation_participant(m.conversation_id)
  )
);

-- No UPDATE/DELETE policies: read receipts are append-only.

-- ============================================================================
-- notifications
-- ============================================================================

-- Recipients read their own notifications; admins read all.
CREATE POLICY notifications_select_owner
ON public.notifications FOR SELECT TO authenticated
USING (recipient_id = auth.uid() OR public.is_admin());

-- No INSERT policy (see file header): notifications are written server-side
-- only, by the fan-out triggers in 0006 and by service_role. Clients cannot
-- forge follow/like/comment/message notifications.

-- Recipients mark their own notifications read (and delete them). The
-- trg_notifications_guard_update trigger (0006) restricts non-admin updates
-- to the read_at column only.
CREATE POLICY notifications_update_owner
ON public.notifications FOR UPDATE TO authenticated
USING (recipient_id = auth.uid() OR public.is_admin())
WITH CHECK (recipient_id = auth.uid() OR public.is_admin());

CREATE POLICY notifications_delete_owner
ON public.notifications FOR DELETE TO authenticated
USING (recipient_id = auth.uid() OR public.is_admin());

-- ============================================================================
-- blocks
-- ============================================================================

-- You can see your own block list; admins see all (moderation).
CREATE POLICY blocks_select_own
ON public.blocks FOR SELECT TO authenticated
USING (blocker_id = auth.uid() OR public.is_admin());

-- You can only block as yourself. (Self-block is impossible by CHECK.)
CREATE POLICY blocks_insert_own
ON public.blocks FOR INSERT TO authenticated
WITH CHECK (blocker_id = auth.uid());

-- Unblock: delete your own block rows.
CREATE POLICY blocks_delete_own
ON public.blocks FOR DELETE TO authenticated
USING (blocker_id = auth.uid());

-- No UPDATE policy: delete + re-insert to change a block.

-- ============================================================================
-- reports
-- ============================================================================

-- Reporters see their own reports; admins see everything (triage queue).
CREATE POLICY reports_select_own_or_admin
ON public.reports FOR SELECT TO authenticated
USING (reporter_id = auth.uid() OR public.is_admin());

-- You can only file reports as yourself.
CREATE POLICY reports_insert_own
ON public.reports FOR INSERT TO authenticated
WITH CHECK (reporter_id = auth.uid());

-- Only admins move reports through the workflow (status / reviewed_at).
CREATE POLICY reports_update_admin
ON public.reports FOR UPDATE TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Only admins can purge reports.
CREATE POLICY reports_delete_admin
ON public.reports FOR DELETE TO authenticated
USING (public.is_admin());
