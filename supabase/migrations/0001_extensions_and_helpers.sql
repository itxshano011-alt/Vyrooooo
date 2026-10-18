-- ============================================================================
-- VYRO migration 0001: extensions, admin list, and shared helper functions
-- Order dependency: FIRST migration. All later migrations depend on helpers
-- defined here (is_admin, touch_updated_at). Visibility helpers
-- (blocked_between, can_view_profile, can_view_video) are defined at the END
-- of migration 0006, after all tables they reference exist (PostgreSQL
-- validates LANGUAGE sql bodies at creation time).
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
CREATE TABLE IF NOT EXISTS public.admins (
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
