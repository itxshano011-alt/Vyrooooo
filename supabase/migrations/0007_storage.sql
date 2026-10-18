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

DROP POLICY IF EXISTS "videos: owner or admin can read" ON storage.objects;
CREATE POLICY "videos: owner or admin can read"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'videos'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
);

DROP POLICY IF EXISTS "videos: owner can upload to own prefix" ON storage.objects;
CREATE POLICY "videos: owner can upload to own prefix"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'videos'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

DROP POLICY IF EXISTS "videos: owner or admin can update" ON storage.objects;
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

DROP POLICY IF EXISTS "videos: owner or admin can delete" ON storage.objects;
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

DROP POLICY IF EXISTS "thumbnails: public read" ON storage.objects;
CREATE POLICY "thumbnails: public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'thumbnails');

DROP POLICY IF EXISTS "thumbnails: owner can upload to own prefix" ON storage.objects;
CREATE POLICY "thumbnails: owner can upload to own prefix"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'thumbnails'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

DROP POLICY IF EXISTS "thumbnails: owner or admin can update" ON storage.objects;
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

DROP POLICY IF EXISTS "thumbnails: owner or admin can delete" ON storage.objects;
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

DROP POLICY IF EXISTS "avatars: public read" ON storage.objects;
CREATE POLICY "avatars: public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars: owner can upload to own prefix" ON storage.objects;
CREATE POLICY "avatars: owner can upload to own prefix"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

DROP POLICY IF EXISTS "avatars: owner or admin can update" ON storage.objects;
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

DROP POLICY IF EXISTS "avatars: owner or admin can delete" ON storage.objects;
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

DROP POLICY IF EXISTS "chat-attachments: owner, admin or participant can read" ON storage.objects;
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

DROP POLICY IF EXISTS "chat-attachments: owner can upload to own prefix" ON storage.objects;
CREATE POLICY "chat-attachments: owner can upload to own prefix"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'chat-attachments'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 1
  AND storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'
);

DROP POLICY IF EXISTS "chat-attachments: owner or admin can update" ON storage.objects;
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

DROP POLICY IF EXISTS "chat-attachments: owner or admin can delete" ON storage.objects;
CREATE POLICY "chat-attachments: owner or admin can delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'chat-attachments'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_admin()
  )
);
