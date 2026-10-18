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
DROP POLICY IF EXISTS profiles_select_public ON public.profiles;
CREATE POLICY profiles_select_public
ON public.profiles FOR SELECT
USING (public.can_view_profile(id));

-- A signed-in user can create exactly their own profile row (id must equal
-- their auth id). Signup normally goes through the handle_new_user trigger.
DROP POLICY IF EXISTS profiles_insert_self ON public.profiles;
CREATE POLICY profiles_insert_self
ON public.profiles FOR INSERT TO authenticated
WITH CHECK (id = auth.uid());

-- Owners edit their own row only. The verified flag and id are additionally
-- guarded by the trg_profiles_guard_privileged trigger (0002).
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
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
DROP POLICY IF EXISTS videos_select_visible ON public.videos;
CREATE POLICY videos_select_visible
ON public.videos FOR SELECT
USING (public.can_view_video(id));

-- Creators insert only as themselves.
DROP POLICY IF EXISTS videos_insert_own ON public.videos;
CREATE POLICY videos_insert_own
ON public.videos FOR INSERT TO authenticated
WITH CHECK (creator_id = auth.uid());

-- Creators edit their own videos (caption, visibility, thumbnail). Admins can
-- edit any video (e.g. moderation caption removal). The
-- trg_videos_guard_status trigger (0003) separately prevents non-admins from
-- touching processing_status / moderation_status / creator_id.
DROP POLICY IF EXISTS videos_update_creator ON public.videos;
CREATE POLICY videos_update_creator
ON public.videos FOR UPDATE TO authenticated
USING (creator_id = auth.uid() OR public.is_admin())
WITH CHECK (creator_id = auth.uid() OR public.is_admin());

-- Creators delete their own videos; admins can remove any video (takedowns).
DROP POLICY IF EXISTS videos_delete_creator ON public.videos;
CREATE POLICY videos_delete_creator
ON public.videos FOR DELETE TO authenticated
USING (creator_id = auth.uid() OR public.is_admin());

-- ============================================================================
-- follows
-- ============================================================================

-- Authenticated users can read follow edges, except edges involving someone
-- they have a block relationship with (either direction).
DROP POLICY IF EXISTS follows_select_all ON public.follows;
CREATE POLICY follows_select_all
ON public.follows FOR SELECT TO authenticated
USING (
  NOT public.blocked_between(follower_id, auth.uid())
  AND NOT public.blocked_between(followed_id, auth.uid())
);

-- You can only follow as yourself, and never across a block (blocked users
-- cannot follow you, and you cannot follow someone you blocked).
DROP POLICY IF EXISTS follows_insert_self ON public.follows;
CREATE POLICY follows_insert_self
ON public.follows FOR INSERT TO authenticated
WITH CHECK (
  follower_id = auth.uid()
  AND NOT public.blocked_between(follower_id, followed_id)
);

-- You can only unfollow yourself.
DROP POLICY IF EXISTS follows_delete_self ON public.follows;
CREATE POLICY follows_delete_self
ON public.follows FOR DELETE TO authenticated
USING (follower_id = auth.uid());

-- ============================================================================
-- video_likes
-- ============================================================================

-- Authenticated users can read likes (needed for counts and liked-state).
DROP POLICY IF EXISTS video_likes_select_all ON public.video_likes;
CREATE POLICY video_likes_select_all
ON public.video_likes FOR SELECT TO authenticated
USING (true);

-- You can only like as yourself, and only videos you are allowed to view.
-- Uniqueness of (user_id, video_id) is enforced by the primary key.
DROP POLICY IF EXISTS video_likes_insert_own ON public.video_likes;
CREATE POLICY video_likes_insert_own
ON public.video_likes FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND public.can_view_video(video_id));

-- You can only unlike your own likes.
DROP POLICY IF EXISTS video_likes_delete_own ON public.video_likes;
CREATE POLICY video_likes_delete_own
ON public.video_likes FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- ============================================================================
-- comments
-- ============================================================================

-- Anyone can read comments on viewable videos.
DROP POLICY IF EXISTS comments_select_visible ON public.comments;
CREATE POLICY comments_select_visible
ON public.comments FOR SELECT
USING (public.can_view_video(video_id));

-- You can only comment as yourself, and only on videos you can view.
DROP POLICY IF EXISTS comments_insert_own ON public.comments;
CREATE POLICY comments_insert_own
ON public.comments FOR INSERT TO authenticated
WITH CHECK (author_id = auth.uid() AND public.can_view_video(video_id));

-- Authors edit their own comments (body only in practice; the app should send
-- body + let the trigger bump updated_at).
DROP POLICY IF EXISTS comments_update_author ON public.comments;
CREATE POLICY comments_update_author
ON public.comments FOR UPDATE TO authenticated
USING (author_id = auth.uid())
WITH CHECK (author_id = auth.uid());

-- Delete: the author, the video creator (moderate your own video), or admin.
DROP POLICY IF EXISTS comments_delete_perms ON public.comments;
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
DROP POLICY IF EXISTS hashtags_select_public ON public.hashtags;
CREATE POLICY hashtags_select_public
ON public.hashtags FOR SELECT
USING (true);

-- Any signed-in user may introduce a tag (normally done by the app when a
-- caption with #tags is posted).
DROP POLICY IF EXISTS hashtags_insert_auth ON public.hashtags;
CREATE POLICY hashtags_insert_auth
ON public.hashtags FOR INSERT TO authenticated
WITH CHECK (true);

-- Only admins rename or remove tags.
DROP POLICY IF EXISTS hashtags_update_admin ON public.hashtags;
CREATE POLICY hashtags_update_admin
ON public.hashtags FOR UPDATE TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS hashtags_delete_admin ON public.hashtags;
CREATE POLICY hashtags_delete_admin
ON public.hashtags FOR DELETE TO authenticated
USING (public.is_admin());

-- ============================================================================
-- video_hashtags
-- ============================================================================

-- Public mapping, readable by everyone.
DROP POLICY IF EXISTS video_hashtags_select_public ON public.video_hashtags;
CREATE POLICY video_hashtags_select_public
ON public.video_hashtags FOR SELECT
USING (true);

-- Only the video's creator (or admin) may tag/untag a video.
DROP POLICY IF EXISTS video_hashtags_insert_creator ON public.video_hashtags;
CREATE POLICY video_hashtags_insert_creator
ON public.video_hashtags FOR INSERT TO authenticated
WITH CHECK (
  public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.videos v
    WHERE v.id = video_hashtags.video_id AND v.creator_id = auth.uid()
  )
);

DROP POLICY IF EXISTS video_hashtags_delete_creator ON public.video_hashtags;
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
DROP POLICY IF EXISTS conversations_select_participant ON public.conversations;
CREATE POLICY conversations_select_participant
ON public.conversations FOR SELECT TO authenticated
USING (public.is_conversation_participant(id) OR public.is_admin());

-- Any signed-in user can start a conversation; they add themselves as the
-- first participant via conversation_participants (see its INSERT policy).
DROP POLICY IF EXISTS conversations_insert_auth ON public.conversations;
CREATE POLICY conversations_insert_auth
ON public.conversations FOR INSERT TO authenticated
WITH CHECK (true);

-- Participants may touch the row (updated_at is normally maintained by the
-- trg_bump_conversation_on_message trigger); admins unrestricted.
DROP POLICY IF EXISTS conversations_update_participant ON public.conversations;
CREATE POLICY conversations_update_participant
ON public.conversations FOR UPDATE TO authenticated
USING (public.is_conversation_participant(id) OR public.is_admin())
WITH CHECK (public.is_conversation_participant(id) OR public.is_admin());

-- Only admins delete whole conversations via the API; users leave via
-- conversation_participants instead.
DROP POLICY IF EXISTS conversations_delete_admin ON public.conversations;
CREATE POLICY conversations_delete_admin
ON public.conversations FOR DELETE TO authenticated
USING (public.is_admin());

-- ============================================================================
-- conversation_participants
-- ============================================================================

-- Participants (and admins) can see who is in their conversations.
DROP POLICY IF EXISTS conversation_participants_select_participant ON public.conversation_participants;
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
DROP POLICY IF EXISTS conversation_participants_insert_managed ON public.conversation_participants;
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
DROP POLICY IF EXISTS conversation_participants_delete_self ON public.conversation_participants;
CREATE POLICY conversation_participants_delete_self
ON public.conversation_participants FOR DELETE TO authenticated
USING (user_id = auth.uid() OR public.is_admin());

-- ============================================================================
-- messages
-- ============================================================================

-- Participants (and admins) can read non-deleted messages in their
-- conversations. Soft-deleted messages are invisible to everyone via RLS.
DROP POLICY IF EXISTS messages_select_participant ON public.messages;
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
DROP POLICY IF EXISTS messages_insert_sender ON public.messages;
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
DROP POLICY IF EXISTS messages_update_sender ON public.messages;
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
DROP POLICY IF EXISTS message_reads_select_visible ON public.message_reads;
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
DROP POLICY IF EXISTS message_reads_insert_own ON public.message_reads;
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
DROP POLICY IF EXISTS notifications_select_owner ON public.notifications;
CREATE POLICY notifications_select_owner
ON public.notifications FOR SELECT TO authenticated
USING (recipient_id = auth.uid() OR public.is_admin());

-- No INSERT policy (see file header): notifications are written server-side
-- only, by the fan-out triggers in 0006 and by service_role. Clients cannot
-- forge follow/like/comment/message notifications.

-- Recipients mark their own notifications read (and delete them). The
-- trg_notifications_guard_update trigger (0006) restricts non-admin updates
-- to the read_at column only.
DROP POLICY IF EXISTS notifications_update_owner ON public.notifications;
CREATE POLICY notifications_update_owner
ON public.notifications FOR UPDATE TO authenticated
USING (recipient_id = auth.uid() OR public.is_admin())
WITH CHECK (recipient_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS notifications_delete_owner ON public.notifications;
CREATE POLICY notifications_delete_owner
ON public.notifications FOR DELETE TO authenticated
USING (recipient_id = auth.uid() OR public.is_admin());

-- ============================================================================
-- blocks
-- ============================================================================

-- You can see your own block list; admins see all (moderation).
DROP POLICY IF EXISTS blocks_select_own ON public.blocks;
CREATE POLICY blocks_select_own
ON public.blocks FOR SELECT TO authenticated
USING (blocker_id = auth.uid() OR public.is_admin());

-- You can only block as yourself. (Self-block is impossible by CHECK.)
DROP POLICY IF EXISTS blocks_insert_own ON public.blocks;
CREATE POLICY blocks_insert_own
ON public.blocks FOR INSERT TO authenticated
WITH CHECK (blocker_id = auth.uid());

-- Unblock: delete your own block rows.
DROP POLICY IF EXISTS blocks_delete_own ON public.blocks;
CREATE POLICY blocks_delete_own
ON public.blocks FOR DELETE TO authenticated
USING (blocker_id = auth.uid());

-- No UPDATE policy: delete + re-insert to change a block.

-- ============================================================================
-- reports
-- ============================================================================

-- Reporters see their own reports; admins see everything (triage queue).
DROP POLICY IF EXISTS reports_select_own_or_admin ON public.reports;
CREATE POLICY reports_select_own_or_admin
ON public.reports FOR SELECT TO authenticated
USING (reporter_id = auth.uid() OR public.is_admin());

-- You can only file reports as yourself.
DROP POLICY IF EXISTS reports_insert_own ON public.reports;
CREATE POLICY reports_insert_own
ON public.reports FOR INSERT TO authenticated
WITH CHECK (reporter_id = auth.uid());

-- Only admins move reports through the workflow (status / reviewed_at).
DROP POLICY IF EXISTS reports_update_admin ON public.reports;
CREATE POLICY reports_update_admin
ON public.reports FOR UPDATE TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Only admins can purge reports.
DROP POLICY IF EXISTS reports_delete_admin ON public.reports;
CREATE POLICY reports_delete_admin
ON public.reports FOR DELETE TO authenticated
USING (public.is_admin());
