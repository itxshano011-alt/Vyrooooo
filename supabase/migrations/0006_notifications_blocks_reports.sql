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
CREATE TABLE IF NOT EXISTS public.notifications (
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

CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
  ON public.notifications (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx
  ON public.notifications (recipient_id, created_at DESC)
  WHERE read_at IS NULL;

-- --------------------------------------------------------------------------
-- blocks
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blocks (
  blocker_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS blocks_blocked_id_idx ON public.blocks (blocked_id);

-- --------------------------------------------------------------------------
-- reports
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reports (
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

CREATE INDEX IF NOT EXISTS reports_status_idx ON public.reports (status);
CREATE INDEX IF NOT EXISTS reports_target_idx ON public.reports (target_type, target_id);

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

DROP TRIGGER IF EXISTS trg_notifications_guard_update ON public.notifications;
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

DROP TRIGGER IF EXISTS trg_notify_on_follow ON public.follows;
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

DROP TRIGGER IF EXISTS trg_notify_on_like ON public.video_likes;
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

DROP TRIGGER IF EXISTS trg_notify_on_comment ON public.comments;
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

DROP TRIGGER IF EXISTS trg_notify_on_message ON public.messages;
CREATE TRIGGER trg_notify_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_message();

-- ============================================================================
-- Visibility helper functions. Defined HERE (end of 0006) rather than in 0001
-- because PostgreSQL validates LANGUAGE sql function bodies at CREATION time:
-- public.blocks (this file), public.profiles (0002) and public.videos (0003)
-- must all exist first. RLS policies in 0008 depend on these.
-- ============================================================================
-- --------------------------------------------------------------------------
-- True when a block exists in either direction between two users.
-- SECURITY DEFINER so RLS policies can call it without recursive policy
-- evaluation. NULL-safe: returns false when either side is NULL (anon).
-- NOTE: defined at the END of migration 0006 because PostgreSQL validates
-- LANGUAGE sql function bodies at CREATION time, so public.blocks must exist first.
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
-- NOTE: defined at the END of migration 0006 because PostgreSQL validates
-- LANGUAGE sql function bodies at CREATION time (public.profiles is from 0002).
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
-- NOTE: defined at the END of migration 0006 because PostgreSQL validates
-- LANGUAGE sql function bodies at CREATION time (public.videos is from 0003).
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

