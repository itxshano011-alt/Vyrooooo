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
