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
