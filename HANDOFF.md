# VYRO — QA & Release Handoff

**Date:** 2026-10-18
**State:** Codebase complete and verified locally. **Not deployed. No live
backend exists.** The user still needs to create a Supabase project, run the
migrations, and deploy (checklist in section D).

This document is the single source of truth for what was done in the QA /
release pass, what passed, what did not get validated, and exactly what the
user must do next. Nothing in here is invented: no credentials, no URLs, no
claims of a working deployment.

---

## A. What was built

VYRO — a real-world short-video social platform (TikTok-style) with private
messenger. Next.js 15 App Router + React 19 + TypeScript (strict) +
Tailwind v4, backed by Supabase (Postgres + Auth + Storage). No demo data,
no fake users, no fabricated counts, no hardcoded success responses
anywhere — every number on screen comes from a real `COUNT(*)` or a real
API response, and every claimed capability maps to implemented code.

Condensed file tree (`~/workspace/vyro/`):

```
.env.example                      5 env vars, exactly matching code usage
eslint.config.mjs                 ESLint 9 flat config (FlatCompat adapter)
next.config.ts / tsconfig.json / postcss.config.mjs
src/
  middleware.ts                   session refresh on every request
  app/
    layout.tsx                    root layout (theme script, metadata)
    page.tsx                      landing page
    (auth)/                       login, signup, verify-email,
                                  forgot-password, reset-password,
                                  auth/callback (route)
    (main)/                       app shell: AuthProvider + ToastProvider +
                                  mobile bottom nav / desktop sidebar
      home/                       For You / Following / Latest feed tabs
      explore/                    search + trending hashtags
      create/                     upload wizard host page
      inbox/                      conversation list (honors ?conversation=<id>)
      inbox/[id]/                 chat thread
      notifications/              with deep links
      profile/[username]/         profile + videos + edit-profile dialog
      settings/                   account, theme, blocks, logout, delete
      admin/                      reports triage, moderation, stats (admin-only)
    video/[id]/                   public video detail (deep link target)
    hashtag/[tag]/                hashtag page (deep link target)
    api/                          30 REST routes:
      account, admin/{moderate,reports,reports/[id],stats}, blocks,
      comments/[id], conversations, conversations/[id]/{messages,read},
      feed, follows, hashtags/[tag], notifications, notifications/read-all,
      profiles/me, reports, search, upload/sign, users/check-username,
      users/[username]{,/followers,/following,/videos},
      videos, videos/[id]{,/comments,/like,/stream}
  components/
    ui/                           Avatar, Button, Dialog, EmptyState,
                                  FieldError, Input, Skeleton, Spinner,
                                  Tabs, Textarea, Toast (single shared set)
    chat/                         ChatWindow, ConversationList,
                                  MessageBubble, dates, urls
    Feed, VideoCard, VideoPlayer, UploadWizard, CommentsSheet,
    ShareDialog, ProfileEditor, ReportDialog, VideoGrid
  hooks/                          useAuth, useFeed, useIntersection,
                                  useUsernameCheck, useDebounce
  lib/
    supabase/{client,server,admin} browser / RLS-scoped / service-role clients
    api-errors.ts                 ApiError + handleRoute (all routes)
    auth.ts                       getSessionUser / requireProfile
    db.ts                         typed rows + enrichVideos + fetchVisibleProfiles
    profile-reads.ts              getVisibleProfileByUsername, getProfileCounts
    video-reads.ts                getViewableVideo (shared visibility rule)
    video-hashtags.ts             syncVideoHashtags (server-side extraction)
    media.ts                      public URLs + resolveVideoUrl (via stream API)
    rate-limit.ts                 in-memory per-IP/per-user limiters
    realtime.ts                   inbox + message subscriptions
    validation.ts                 zod schemas + hashtag extraction
    config.ts                     branding + upload limits (one place)
supabase/migrations/
  0001 extensions/helpers  0002 profiles  0003 videos  0004 social
  0005 messaging  0006 notifications/blocks/reports
  0007 storage (4 buckets + 16 policies)  0008 RLS (46 policies)
docs/  DEPLOYMENT.md (step-by-step)  SECURITY.md (RLS model + test checklist)
```

### What the QA pass changed (Phase 1 fixes)

1. **Non-route exports moved out of route modules** (Next 15 build
   failure): `getVisibleProfileByUsername` / `getProfileCounts` →
   `src/lib/profile-reads.ts`; `syncVideoHashtags` →
   `src/lib/video-hashtags.ts`; `getViewableVideo` / `enrichOne` →
   `src/lib/video-reads.ts`. All 8 importing routes updated; no behavior
   change.
2. **`@types/node` installed properly** (`26.6.5`, exact pin in
   devDependencies); the `src/process-env.d.ts` shim deleted.
3. **New route `GET /api/videos/[id]/stream`** — the critical missing
   piece for public playback. It runs the identical visibility check as
   the video detail endpoint (404 for anything not viewable), then mints a
   1-hour signed URL with the service-role client and returns
   `{url, expires_at}`. `resolveVideoUrl` in `src/lib/media.ts` and
   `VideoPlayer` now use it (by video id) instead of client-side signed-URL
   minting, so public videos play for any viewer including logged-out
   users. No client-side storage credentials for videos remain.
4. **Inbox honors `?conversation=<id>`**: the profile "Message" button
   routes to `/inbox?conversation=<id>`; on mount the inbox replaces to
   `/inbox/<id>` (Suspense-wrapped for `useSearchParams`).
5. **ESLint fixed**: root cause was not a corrupt tree — the config used
   an extensionless ESM import (`eslint-config-next/core-web-vitals`) that
   Node 24's ESM loader cannot resolve, and the package (15.5.28) only
   ships the legacy eslintrc shape anyway. Fixed with the documented
   `FlatCompat` adapter and a properly declared `@eslint/eslintrc@3.3.7`
   devDependency. Also fixed one real lint error
   (`react/no-unescaped-entities` in settings).
6. **tsc clean**, including the previously reported ShareDialog area (no
   ShareDialog error exists in the final tree).

### Extra issues found and fixed during verification

- **Dead button:** Settings → "Edit profile" pushed to `/profile`, which
  does not exist (the editor is a dialog on your own profile page). Now
  routes to `/profile/<your-username>`.
- **`.env.example` drift:** listed `NEXT_PUBLIC_SITE_URL` and
  `NEXT_PUBLIC_SITE_NAME`, which no code reads. Removed; the file now
  matches the 5 env vars actually consumed.
- **`docs/DEPLOYMENT.md` inaccuracies fixed:** step 3 wrongly told the
  user to create buckets manually with wrong visibility (buckets are
  created by migration 0007 — now stated, with the correct table and a
  verification step); step 4 referenced the removed `NEXT_PUBLIC_SITE_URL`;
  added an admin-seeding step and a troubleshooting section.
- **`docs/SECURITY.md`:** verified accurate against the final code (46
   table policies, 16 storage policies — counted from the migrations);
   added a subsection documenting the new stream endpoint as the
   sanctioned server-side playback path.

---

## B. Validation results

All commands run from `~/workspace/vyro/` with `node_modules` installed.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** — `tsc --noEmit` clean, 0 errors |
| Lint | `npm run lint` | **PASS** — 0 errors, 4 warnings (all `@next/next/no-img-element` for avatar/thumbnail `<img>` tags: deliberate, dynamic storage URLs with no `next/image` loader configured) |
| Tests | `npm run test` | **PASS** — 2 files, **26/26** tests |
| Production build | `npm run build` | **PASS** — compiled in ~12s, 33/33 static pages, all 30 API routes + 15 pages emitted |
| SQL syntax | `pglast.parse_sql` on all 8 files | **PASS** — 0001(13) 0002(13) 0003(12) 0004(20) 0005(22) 0006(23) 0007(17) 0008(46) statements, 0 parse errors |
| RPC cross-check | every `.rpc("…")` in `src/` vs functions defined in migrations | **PASS** — `is_admin`, `blocked_between`, `is_conversation_participant` all defined |
| Bucket cross-check | buckets referenced in code vs migration 0007 | **PASS** — `videos`, `thumbnails`, `avatars`, `chat-attachments` all created by 0007 |
| Service-role isolation | `grep SUPABASE_SERVICE_ROLE_KEY` outside `src/app/api/**` and `src/lib/supabase/admin.ts` | **PASS** — none; no `supabase/admin` import in any client component |
| Env coverage | `process.env.*` in `src/` vs `.env.example` | **PASS** — exact match (5 vars) after cleanup |
| No-emoji comments | scan of code comments | **PASS** — none |
| No fake data | scan for fake/mock/placeholder data patterns | **PASS** — none (one benign comment about hardcoded error strings) |
| Deep-link targets | `/video/[id]`, `/profile/[username]`, `/inbox/[id]`, `/hashtag/[tag]` | **PASS** — all exist; notification `deepLinkFor` targets verified |
| Internal navigation sweep | every `router.push/replace` + `href` target | **PASS** — all resolve (one dead `/profile` link fixed) |
| Auth coverage | `AuthProvider` wrapping | **PASS** — `(main)`, `/video`, `/hashtag` layouts |

Key flows traced (static review, no live backend): signup → verify-email
notice → login → home tabs (For You/Following/Latest, Following gated with
`?next=` login redirect); create wizard (source → preview → details →
publish → done → routes to `/video/<id>`); inbox list → thread (send via
POST messages, realtime receive, read receipts); settings (theme, blocks,
logout, delete account); admin page (403-guarded by API).

**Build env note:** `next build` requires the three Supabase env vars at
build time (deliberate fail-fast design — the app refuses to boot
misconfigured). Verification used obvious placeholders
(`https://build-verification.invalid` + `build-verification-dummy-*`
keys). These are **not** credentials and prove nothing about backend
connectivity — only that compilation, type/lint checks, and route
collection succeed.

---

## C. What was NOT validated (and why)

1. **No live Supabase project exists.** The user has not created one, so
   there was no database, no Auth, no storage to test against. Every
   backend behavior (RLS policies, triggers, realtime, signed URLs) is
   verified by code/SQL review only.
2. **No end-to-end test.** Signup, upload, playback, messaging, and
   moderation flows were traced statically but never executed against a
   real backend. The first real E2E happens when the user follows the
   checklist in section D.
3. **Video transcoding is NOT implemented.** Uploaded videos play exactly
   as uploaded (`processing_status='published'` immediately). There is no
   transcoding pipeline, no thumbnail auto-generation on the server (the
   client captures a frame pre-upload), and no `pending`/`processing`
   lifecycle wired to a worker. This is stated honestly in the code and
   docs — do not claim otherwise.
4. **Rate limiter is in-memory.** It resets on every redeploy / serverless
   scale-out. Works for a single instance; Redis is the documented upgrade
   path (not implemented).
5. **Realtime depends on Supabase Realtime** being enabled on the
   `messages`/`conversations` tables in the user's project (default on for
   new projects, but untested here).
6. **Email delivery** (signup confirmation, password reset) depends on the
   Supabase project's email settings — untested, see DEPLOYMENT.md
   troubleshooting.

No migration files were modified: all 8 parsed cleanly and every
code-referenced RPC/bucket/policy exists. There was no genuine SQL bug to
fix.

---

## D. User-action checklist (beginner steps — nothing is done for you yet)

Do these **in order**. Each needs your own accounts.

1. **Create a Supabase project.** Go to supabase.com → sign up → **New
   project**. Name it `vyro`, set a database password (save it), pick the
   region closest to you. Wait until it finishes provisioning.
2. **Copy your three keys.** In the project dashboard: **Project
   Settings → API**. Copy the **Project URL**, the **anon public** key,
   and the **service_role** secret key into a temporary note. (The
   service_role key is secret — never share it, never put it in the
   browser.)
3. **Run the 8 migrations.** **SQL Editor → New query**. Open
   `supabase/migrations/0001_extensions_and_helpers.sql` from this repo,
   paste it all, **Run**. Repeat for `0002` … `0008` **in order**. Each
   must succeed before the next.
4. **Check the buckets.** **Storage** should now show 4 buckets: `videos`
   (private), `thumbnails` (public), `avatars` (public),
   `chat-attachments` (private). You did not create them — migration 0007
   did. If one is missing, re-run the `0007` file.
5. **Set your env vars.** Copy `.env.example` to `.env.local` and fill in
   the three Supabase values from step 2 (leave the two
   `NEXT_PUBLIC_MAX_VIDEO_*` defaults unless you want different limits).
6. **Run it locally.** `npm install`, then `npm run dev`, open
   http://localhost:3000, sign up, upload a video, confirm it plays.
7. **Deploy to Vercel.** Push this folder to GitHub. On vercel.com →
   **New Project** → import the repo → add the **same five** env vars in
   **Settings → Environment Variables** → **Deploy**.
8. **(Optional) Make yourself admin.** After signing up, find your user
   UUID in Supabase **Authentication → Users**, then run once in SQL
   Editor: `INSERT INTO public.admins (user_id) VALUES ('<your-uuid>');`
   The `/admin` page will then work for you.
9. **Verify live.** Sign up → upload → feed plays → like/comment →
   profile **Message** → chat works. Full walkthrough in
   `docs/DEPLOYMENT.md` steps 6–7.

---

## E. Known limitations (do not over-claim)

- **In-memory rate limiter** resets on redeploy; Redis is the upgrade path
  (not implemented).
- **For You ranking is a simple documented heuristic**, not a learned
  recommendation model.
- **No push notifications** (in-app notification center only).
- **No end-to-end encryption on messages** — transport + database
  security only. Do not claim E2E encryption.
- **No video transcoding** (see C.3).
- **No offline support**, no native mobile apps (responsive web app).
- Realtime features need Supabase Realtime enabled on the project.

---

## Files changed in this pass

- `src/lib/profile-reads.ts` *(new)*, `src/lib/video-hashtags.ts` *(new)*,
  `src/lib/video-reads.ts` *(new)*
- `src/app/api/users/check-username/route.ts` — removed non-route exports
- `src/app/api/videos/route.ts` — removed non-route export, imports helper
- `src/app/api/videos/[id]/route.ts` — uses shared lib helpers
- `src/app/api/videos/[id]/stream/route.ts` *(new)* — signed playback URLs
- `src/app/api/users/[username]/{route,videos,followers,following}/route.ts`,
  `src/app/api/profiles/me/route.ts`, `src/app/api/follows/route.ts` —
  import path updates
- `src/lib/media.ts` — `resolveVideoUrl(videoId)` via the stream endpoint
- `src/components/VideoPlayer.tsx` — `videoId` prop (was `storagePath`)
- `src/app/video/[id]/page.tsx`, `src/components/VideoCard.tsx` — pass `videoId`
- `src/app/(main)/inbox/page.tsx` — honors `?conversation=<id>`
- `src/app/(main)/settings/page.tsx` — fixed dead "Edit profile" link +
  one lint-error fix (`&apos;`)
- `eslint.config.mjs` — FlatCompat adapter (was unresolvable)
- `package.json` / `package-lock.json` — added `@types/node@26.6.5`,
  `@eslint/eslintrc@3.3.7` (exact pins)
- `src/process-env.d.ts` — deleted (shim no longer needed)
- `.env.example` — removed 2 unconsumed vars
- `README.md`, `docs/DEPLOYMENT.md`, `docs/SECURITY.md` — finalized/corrected
- `HANDOFF.md` *(new)* — this file

Nothing left unresolved in code. The remaining work is entirely the
user's: Supabase project → migrations → env vars → Vercel deploy.
