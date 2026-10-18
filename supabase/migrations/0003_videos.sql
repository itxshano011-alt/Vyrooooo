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
