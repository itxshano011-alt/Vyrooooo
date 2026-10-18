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

CREATE TABLE IF NOT EXISTS public.profiles (
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

CREATE INDEX IF NOT EXISTS profiles_created_at_idx ON public.profiles (created_at DESC);
CREATE INDEX IF NOT EXISTS profiles_username_trgm_idx ON public.profiles USING gin (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_display_name_trgm_idx ON public.profiles USING gin (display_name gin_trgm_ops);

DROP TRIGGER IF EXISTS trg_profiles_touch_updated_at ON public.profiles;
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

DROP TRIGGER IF EXISTS trg_profiles_guard_privileged ON public.profiles;
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
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
