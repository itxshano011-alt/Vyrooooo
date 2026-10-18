# VYRO Security Documentation

Database security model for the VYRO Supabase backend: every RLS policy,
the threat model, and a test checklist. The schema lives in
`supabase/migrations/0001-0008`; this document is its security companion.

## 1. Design principles

1. **Deny by default.** Every table has `ENABLE ROW LEVEL SECURITY` with no
   permissive default. Access exists only where a named policy grants it.
2. **Admin is server-side only.** There is no `role` column on profiles and no
   client-writable admin flag anywhere. `public.is_admin()` (migration 0001)
   is `SECURITY DEFINER` and reads the private `admins` table, which has RLS
   enabled and **zero policies** — no client role can read or write it.
   Seed it once as `service_role`:
   `INSERT INTO public.admins (user_id) VALUES ('<uuid>');`
3. **Visibility logic is centralized.** `can_view_profile()`, `can_view_video()`,
   `blocked_between()` (0001) and `is_conversation_participant()` (0005) are
   `SECURITY DEFINER` helpers shared by all policies, so rules cannot drift
   between tables. `SECURITY DEFINER` also avoids recursive RLS evaluation.
4. **Defense in depth with triggers.** RLS decides *who* may touch a row;
   `BEFORE UPDATE` guard triggers decide *what* they may change:
   - `trg_profiles_guard_privileged` — `verified`/`id` immutable for non-admins.
   - `trg_videos_guard_status` — `processing_status`/`moderation_status`/
     `creator_id` changeable only by `service_role` (upload pipeline) or admin.
   - `trg_messages_guard_immutable` — `sender_id`/`conversation_id` immutable.
   - `trg_notifications_guard_update` — non-admins may only change `read_at`.
5. **Counts are computed, never stored.** Follower/like/comment counts are
   `COUNT(*)` over indexed FKs (see counter strategy in `0001`). No
   trigger-maintained counters, so there is nothing to desynchronize.
6. **Notifications are server-written.** There is no client `INSERT` policy on
   `notifications`; rows come from DB fan-out triggers (0006) or
   `service_role` (Edge Functions). Clients cannot forge notifications.
7. **Storage path convention.** Writable bucket paths must match
   `<auth.uid()>/<uuid>.<ext>` (one folder level = uploader id, UUID
   filename). Enforced in `WITH CHECK` on every bucket write policy.

## 2. RLS policy inventory

### `profiles` (3 policies)
| Policy | Command | Rule |
|---|---|---|
| `profiles_select_public` | SELECT (all roles) | `can_view_profile(id)`: public accounts visible; private visible to owner/admin; hidden across blocks in both directions |
| `profiles_insert_self` | INSERT (authenticated) | `id = auth.uid()` — you create only your own row |
| `profiles_update_self` | UPDATE (authenticated) | owner only; trigger additionally locks `verified`/`id` |
| — | DELETE | **no policy** — account deletion goes through `auth.users`, which cascades |

### `videos` (4 policies)
| Policy | Command | Rule |
|---|---|---|
| `videos_select_visible` | SELECT (all roles) | `can_view_video(id)`: public + published + `moderation_status='ok'`; always visible to creator and admin; hidden across blocks |
| `videos_insert_own` | INSERT (authenticated) | `creator_id = auth.uid()` |
| `videos_update_creator` | UPDATE (authenticated) | creator or admin; trigger locks status fields for non-admins |
| `videos_delete_creator` | DELETE (authenticated) | creator or admin (takedowns) |

### `follows` (3 policies)
| Policy | Command | Rule |
|---|---|---|
| `follows_select_all` | SELECT (authenticated) | readable unless a block exists between viewer and either party |
| `follows_insert_self` | INSERT (authenticated) | `follower_id = auth.uid()` and no block between the two users |
| `follows_delete_self` | DELETE (authenticated) | `follower_id = auth.uid()` (unfollow) |

### `video_likes` (3 policies)
| Policy | Command | Rule |
|---|---|---|
| `video_likes_select_all` | SELECT (authenticated) | all likes readable (counts / liked-state) |
| `video_likes_insert_own` | INSERT (authenticated) | `user_id = auth.uid()` **and** the video is viewable by the liker |
| `video_likes_delete_own` | DELETE (authenticated) | `user_id = auth.uid()` |

### `comments` (4 policies)
| Policy | Command | Rule |
|---|---|---|
| `comments_select_visible` | SELECT (all roles) | comments on viewable videos only |
| `comments_insert_own` | INSERT (authenticated) | `author_id = auth.uid()` and video viewable |
| `comments_update_author` | UPDATE (authenticated) | author only |
| `comments_delete_perms` | DELETE (authenticated) | author, video creator (moderate own video), or admin |

### `hashtags` (4 policies)
| Policy | Command | Rule |
|---|---|---|
| `hashtags_select_public` | SELECT (all roles) | public discovery data |
| `hashtags_insert_auth` | INSERT (authenticated) | any signed-in user may introduce a tag |
| `hashtags_update_admin` | UPDATE (authenticated) | admin only |
| `hashtags_delete_admin` | DELETE (authenticated) | admin only |

### `video_hashtags` (3 policies)
| Policy | Command | Rule |
|---|---|---|
| `video_hashtags_select_public` | SELECT (all roles) | public |
| `video_hashtags_insert_creator` | INSERT (authenticated) | video creator or admin |
| `video_hashtags_delete_creator` | DELETE (authenticated) | video creator or admin |

### `conversations` (4 policies)
| Policy | Command | Rule |
|---|---|---|
| `conversations_select_participant` | SELECT (authenticated) | participant or admin |
| `conversations_insert_auth` | INSERT (authenticated) | any signed-in user may start one (then bootstraps own membership) |
| `conversations_update_participant` | UPDATE (authenticated) | participant or admin |
| `conversations_delete_admin` | DELETE (authenticated) | admin only; users leave via `conversation_participants` |

### `conversation_participants` (3 policies)
| Policy | Command | Rule |
|---|---|---|
| `conversation_participants_select_participant` | SELECT (authenticated) | participant or admin |
| `conversation_participants_insert_managed` | INSERT (authenticated) | admin, OR self-insert as first participant of a fresh conversation (bootstrap), OR added by an existing participant; never across a block |
| `conversation_participants_delete_self` | DELETE (authenticated) | own row (leave) or admin (remove) |

### `messages` (3 policies)
| Policy | Command | Rule |
|---|---|---|
| `messages_select_participant` | SELECT (authenticated) | participant or admin; `deleted_at IS NOT NULL` rows invisible to all clients |
| `messages_insert_sender` | INSERT (authenticated) | `sender_id = auth.uid()`, must be a participant, and no block between sender and any other participant |
| `messages_update_sender` | UPDATE (authenticated) | sender's own non-deleted messages (edit / soft-delete via `deleted_at`) |
| — | DELETE | **no policy** — soft-delete only via clients; hard delete is `service_role` only |

### `message_reads` (2 policies)
| Policy | Command | Rule |
|---|---|---|
| `message_reads_select_visible` | SELECT (authenticated) | own receipts, or receipts on messages in your conversations (seen ticks), or admin |
| `message_reads_insert_own` | INSERT (authenticated) | `user_id = auth.uid()` in a conversation you participate in |
| — | UPDATE/DELETE | **no policies** — receipts are append-only |

### `notifications` (3 policies)
| Policy | Command | Rule |
|---|---|---|
| `notifications_select_owner` | SELECT (authenticated) | recipient or admin |
| — | INSERT | **no policy** — server-written only (triggers / `service_role`) |
| `notifications_update_owner` | UPDATE (authenticated) | recipient or admin; trigger restricts non-admins to `read_at` |
| `notifications_delete_owner` | DELETE (authenticated) | recipient or admin |

### `blocks` (3 policies)
| Policy | Command | Rule |
|---|---|---|
| `blocks_select_own` | SELECT (authenticated) | own block list or admin |
| `blocks_insert_own` | INSERT (authenticated) | `blocker_id = auth.uid()` |
| `blocks_delete_own` | DELETE (authenticated) | own rows (unblock) |
| — | UPDATE | **no policy** — delete + re-insert |

### `reports` (4 policies)
| Policy | Command | Rule |
|---|---|---|
| `reports_select_own_or_admin` | SELECT (authenticated) | reporter or admin (triage queue) |
| `reports_insert_own` | INSERT (authenticated) | `reporter_id = auth.uid()` |
| `reports_update_admin` | UPDATE (authenticated) | admin only (workflow: `status`, `reviewed_at`) |
| `reports_delete_admin` | DELETE (authenticated) | admin only |

### `admins` (0 policies)
RLS enabled, no policies: invisible and immutable to all client roles.

**Table policy total: 46 named policies.**

## 3. Storage policies (`storage.objects`, 16 policies)

| Bucket | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `videos` (private) | owner or admin (authenticated) | owner, path `<uid>/<uuid>.<ext>` enforced | owner or admin (USING) / owner path (WITH CHECK) | owner or admin |
| `thumbnails` (public) | **public read** | owner, path enforced | owner or admin / owner path | owner or admin |
| `avatars` (public) | **public read** | owner, path enforced | owner or admin / owner path | owner or admin |
| `chat-attachments` (private) | owner, admin, or participant of a conversation with a non-deleted message referencing the file | owner, path enforced | owner or admin / owner path | owner or admin |

Path enforcement on every write: `(storage.foldername(name))[1] = auth.uid()::text`,
exactly one folder level, and `storage.filename(name) ~ '^[0-9a-f-]{36}\.[a-z0-9]+$'`.
The app must upload with key `<user_id>/<uuid>.<ext>` or the insert is rejected.

### Server-side playback (API layer, not a storage policy)

Because the `videos` bucket is private, browsers cannot fetch video bytes
directly. The sanctioned playback path is `GET /api/videos/[id]/stream`
(`src/app/api/videos/[id]/stream/route.ts`):

1. It reuses `getViewableVideo()` — the exact same check as the video
   detail endpoint (RLS `can_view_video` + API-level creator visibility).
   Anything the caller may not view returns 404, indistinguishable from
   "does not exist".
2. Only then it mints a 1-hour signed URL with the `service_role` client.

The frontend resolves every playable URL through this endpoint
(`resolveVideoUrl` in `src/lib/media.ts`); no video signed-URL minting
happens client-side. A signed URL is bearer-capable for its 1-hour life,
but it can only ever be minted for a video the caller was already allowed
to view, so it grants no new access — it only converts authorized access
into bytes. Chat attachments keep client-side minting because their storage
policy explicitly grants SELECT to conversation participants.

## 4. Threat model

| Threat | Mitigation |
|---|---|
| **A reads B's private profile/video/messages** | `can_view_profile` / `can_view_video` / participant-only message policies; private buckets require owner path or participant link |
| **A forges content as B** (videos, likes, comments, messages, follows) | every write policy pins the actor column to `auth.uid()`; immutable-field triggers |
| **A escalates to admin / verifies self** | no client-writable role; `verified` locked by trigger; `admins` table has no client policies |
| **A clears their own moderation flag / publishes a failed upload** | `trg_videos_guard_status`: status fields are `service_role`/admin-only |
| **A spams notifications as someone else** | no client INSERT on `notifications`; fan-out triggers skip self-actions and blocked pairs |
| **Blocked user circumvents block** (view content, follow, DM, get notified) | `blocked_between` enforced in profile/video/follow/message/notification paths; both directions |
| **URL tampering** (guessing conversation/message/video ids) | ids are unguessable UUIDs **and** every read is membership/visibility-checked — knowledge of an id alone grants nothing |
| **A deletes B's content** | delete policies are owner-scoped (+ admin where moderation needs it); messages have no client hard-delete at all |
| **A joins arbitrary conversations** | participant INSERT requires bootstrap-as-self on a fresh conversation or an existing participant adding you; never across blocks |
| **A reads another user's raw uploads** | `videos` bucket is private; SELECT requires owner path or admin |
| **A writes outside their storage prefix** | `WITH CHECK` path-prefix + UUID-filename enforcement on all four buckets |
| **A enumerates users via search** | trigram search only returns rows the existing `profiles_select_public` policy allows |
| **JWT/role confusion** | policies use `auth.uid()` (from the verified JWT `sub` claim); `service_role` bypass is by design for backend jobs |

Known accepted limitations (documented, not fixed in schema):
- `video_likes` SELECT is visible to all authenticated users (needed for counts);
  like activity is not treated as private.
- A sender who leaves a conversation can still edit their old messages.
- Notification fan-out inserts one row per message per recipient (no
  upsert/coalescing); high-volume chats should be rate-limited in the app.
- Rate limiting, upload size caps, and content moderation pipelines are
  application/Edge-Function concerns, not enforced here.

## 5. Security test checklist

Run each as the named role. In the Supabase SQL editor you can impersonate a
user inside a transaction (rolled back afterwards):

```sql
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"<USER_A_UUID>","role":"authenticated"}', true);
-- ... test query ...
ROLLBACK;
```

### Profiles
- [ ] Anon `SELECT` on `profiles` returns only `is_private = false` rows.
- [ ] User A cannot `SELECT` user B's private profile (0 rows).
- [ ] User A `UPDATE profiles SET verified = true WHERE id = A` → **error**
      (guard trigger), even though the RLS policy allows the row update.
- [ ] User A `UPDATE profiles SET id = <other> WHERE id = A` → **error**.
- [ ] User A `DELETE FROM profiles WHERE id = A` → **0 rows affected**
      (no DELETE policy).

### Videos
- [ ] Anon feed query (public/published/ok) works; `visibility='private'`,
      `processing_status='failed'`, and `moderation_status='flagged'` rows are
      absent for non-owners.
- [ ] User A `INSERT INTO videos (creator_id, ...) VALUES (B, ...)` → **error**
      (WITH CHECK).
- [ ] User A `UPDATE videos SET processing_status='published'` on own
      `pending` video → **error** (guard trigger).
- [ ] User A `UPDATE videos SET caption='x' WHERE creator_id = B` →
      **0 rows** (policy).
- [ ] Admin (uuid in `admins`) can `UPDATE`/`DELETE` any video.

### Social
- [ ] User A `INSERT INTO follows (follower_id, followed_id) VALUES (B, B)` →
      **error** (CHECK `follower_id <> followed_id`).
- [ ] After B blocks A: A `INSERT INTO follows ... (A, B)` → **error**;
      A's `SELECT` on `follows` no longer returns B's edges.
- [ ] User A likes B's **private** video by id → **error** (`can_view_video`
      in WITH CHECK).
- [ ] Duplicate like `(A, video)` → **unique violation**.
- [ ] User A comments on B's private video → **error**.
- [ ] User B (video creator) `DELETE`s A's comment on B's video → **allowed**;
      user C (stranger) → **0 rows**.
- [ ] Non-admin `UPDATE hashtags SET tag='x'` → **0 rows**; admin → allowed.

### Messaging
- [ ] User C (non-participant) `SELECT` on conversation A↔B messages →
      **0 rows** (id guessing grants nothing).
- [ ] User C `INSERT INTO messages (conversation_id=A↔B, sender_id=C, ...)` →
      **error**.
- [ ] User A `INSERT` with `sender_id = B` → **error** (WITH CHECK).
- [ ] After B blocks A: A `INSERT INTO messages` in A↔B conversation →
      **error**.
- [ ] User A `UPDATE messages SET conversation_id=<other>` → **error**
      (guard trigger).
- [ ] User A sets `deleted_at` on own message → row disappears from
      participant `SELECT`s (soft delete).
- [ ] User C `INSERT INTO conversation_participants (conversation_id, user_id)`
      values `(A↔B convo, C)` → **error** (not bootstrap, not added by member).
- [ ] User C `INSERT INTO message_reads (message_id, user_id)` with
      `user_id = A` → **error**.
- [ ] `UPDATE`/`DELETE` on `message_reads` as anyone → **0 rows / error**.

### Notifications / blocks / reports
- [ ] User A `INSERT INTO notifications (...)` → **error** (no INSERT policy).
- [ ] Liking own video / commenting on own video creates **no** notification
      (self-action skip in triggers).
- [ ] After B blocks A: A follows B → **no** notification row for B.
- [ ] User A `UPDATE notifications SET type='moderation'` on own row →
      **error** (guard trigger); setting `read_at` → allowed.
- [ ] User A `SELECT` on `blocks` returns only A's rows; B's block list
      invisible.
- [ ] User A `UPDATE reports SET status='actioned'` on own report →
      **0 rows** (admin only).
- [ ] Anon `SELECT` on `reports` → **0 rows**.

### Admin gating
- [ ] `SELECT * FROM admins` as authenticated non-admin → **0 rows**.
- [ ] `INSERT INTO admins` as authenticated → **error** (no policy).
- [ ] `SELECT public.is_admin()` as non-admin → `false`; after seeding the
      uuid, → `true`.

### Storage
- [ ] Anon `SELECT` on `storage.objects` where `bucket_id='videos'` → **0 rows**;
      `bucket_id='thumbnails'`/`'avatars'` → allowed.
- [ ] User A uploads to `videos` with key `B/<uuid>.mp4` → **error**
      (prefix must be A's uid).
- [ ] User A uploads with key `A/not-a-uuid.mp4` → **error** (filename shape).
- [ ] User A uploads with key `A/sub/<uuid>.mp4` → **error** (one level only).
- [ ] User C (non-participant) reads `chat-attachments` file referenced only
      by A↔B messages → **denied**; B (participant) → allowed.
- [ ] After the referencing message is soft-deleted, participant read of the
      attachment is **denied** (message no longer matches `deleted_at IS NULL`).

### Regression after any policy change
- [ ] Re-run the full checklist; pay special attention to anon feed/search
      (they rely on the no-`TO`-clause public SELECT policies).
