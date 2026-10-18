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

CREATE TABLE IF NOT EXISTS public.videos (
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

CREATE INDEX IF NOT EXISTS videos_creator_id_idx ON public.videos (creator_id);
CREATE INDEX IF NOT EXISTS videos_created_at_idx ON public.videos (created_at DESC);
CREATE INDEX IF NOT EXISTS videos_creator_feed_idx ON public.videos (creator_id, created_at DESC);
-- Hot path: global public feed of viewable videos.
CREATE INDEX IF NOT EXISTS videos_public_feed_idx ON public.videos (created_at DESC)
  WHERE visibility = 'public' AND processing_status = 'published' AND moderation_status = 'ok';

DROP TRIGGER IF EXISTS trg_videos_touch_updated_at ON public.videos;
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

DROP TRIGGER IF EXISTS trg_videos_guard_status ON public.videos;
CREATE TRIGGER trg_videos_guard_status
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.guard_video_status_fields();

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
CREATE TABLE IF NOT EXISTS public.follows (
  follower_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followed_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS follows_followed_id_idx ON public.follows (followed_id);
CREATE INDEX IF NOT EXISTS follows_follower_created_idx ON public.follows (follower_id, created_at DESC);

-- --------------------------------------------------------------------------
-- video_likes
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.video_likes (
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  video_id   uuid        NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);
ALTER TABLE public.video_likes ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS video_likes_video_id_idx ON public.video_likes (video_id);
CREATE INDEX IF NOT EXISTS video_likes_video_created_idx ON public.video_likes (video_id, created_at DESC);

-- --------------------------------------------------------------------------
-- comments
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   uuid        NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  author_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS comments_video_created_idx ON public.comments (video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS comments_author_id_idx ON public.comments (author_id);

DROP TRIGGER IF EXISTS trg_comments_touch_updated_at ON public.comments;
CREATE TRIGGER trg_comments_touch_updated_at
  BEFORE UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- --------------------------------------------------------------------------
-- hashtags (normalized: lowercase, no leading '#')
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hashtags (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag  text NOT NULL UNIQUE CHECK (tag ~ '^[a-z0-9_]{1,64}$')
);
COMMENT ON COLUMN public.hashtags.tag IS 'Normalized tag: lowercase, no leading #, 1-64 chars of [a-z0-9_].';
ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS hashtags_tag_trgm_idx ON public.hashtags USING gin (tag gin_trgm_ops);

-- --------------------------------------------------------------------------
-- video_hashtags (many-to-many)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.video_hashtags (
  video_id   uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, hashtag_id)
);
ALTER TABLE public.video_hashtags ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS video_hashtags_hashtag_id_idx ON public.video_hashtags (hashtag_id);
