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

CREATE TABLE IF NOT EXISTS public.conversations (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON public.conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.conversation_participants (
  conversation_id uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS conversation_participants_user_id_idx
  ON public.conversation_participants (user_id);

CREATE TABLE IF NOT EXISTS public.messages (
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

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON public.messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_sender_id_idx ON public.messages (sender_id);

CREATE TABLE IF NOT EXISTS public.message_reads (
  message_id uuid        NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
COMMENT ON TABLE public.message_reads IS 'Read receipts. Append-only: no UPDATE or DELETE via client RLS.';
ALTER TABLE public.message_reads ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS message_reads_user_id_idx ON public.message_reads (user_id);

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

DROP TRIGGER IF EXISTS trg_bump_conversation_on_message ON public.messages;
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

DROP TRIGGER IF EXISTS trg_messages_guard_immutable ON public.messages;
CREATE TRIGGER trg_messages_guard_immutable
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_immutable_fields();
