# VYRO

VYRO is a real-world short-video social media platform (TikTok-style) with a
private messenger, built as a responsive full-stack web app.

- **Feed:** vertically-scrolling short video feed (For You / Following /
  Latest) with likes, comments, shares
- **Upload:** 4-step upload wizard (source → preview → details → publish)
  with size/duration limits enforced server-side
- **Social:** user profiles, follows/followers, notifications with deep links
- **Messenger:** one-to-one private messaging with attachments, read
  receipts, realtime delivery
- **Admin:** reports triage queue, moderation actions, platform stats
  (admin-gated via the `admins` table)

## Tech stack

- Next.js 15 (App Router, React 19, TypeScript strict)
- Tailwind CSS v4 (CSS-first, CSS variables theming, dark default)
- Supabase (Postgres, Auth, Storage) via `@supabase/ssr`
- react-hook-form + zod for forms and validation
- vitest for tests, ESLint 9 (flat config) for lint

## Prerequisites

You need your **own Supabase project** — none is provisioned for you yet.
Sign up at [supabase.com](https://supabase.com), create a project, and run the
SQL migrations in `supabase/migrations/` against it (in numeric order).
The storage buckets (`videos`, `thumbnails`, `avatars`, `chat-attachments`)
are created by migration `0007` — no manual bucket setup needed.

## Quickstart

```bash
# 1. Copy the env template and fill in your own Supabase keys
cp .env.example .env.local

# 2. Install dependencies
npm install

# 3. Run the dev server
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Scripts

| Script            | What it does                              |
| ----------------- | ----------------------------------------- |
| `npm run dev`     | Start the dev server                      |
| `npm run build`   | Production build (runs lint + typecheck)  |
| `npm run start`   | Serve the production build                |
| `npm run lint`    | ESLint (0 errors expected)                |
| `npm run typecheck` | TypeScript strict check (`tsc --noEmit`) |
| `npm test`        | vitest (run once)                         |

## Project structure

```
src/
  app/
    (auth)/            login, signup, verify-email, forgot/reset-password, auth callback
    (main)/            app shell (AuthProvider + nav): home, explore, create,
                       inbox (+ [id] thread), notifications, profile/[username],
                       settings, admin
    video/[id]/        public video detail page (deep link target)
    hashtag/[tag]/      hashtag page (deep link target)
    api/               30 REST routes (see below)
  components/
    ui/                shared primitives: Button, Input, Dialog, Avatar, Toast, ...
    chat/              ChatWindow, ConversationList, MessageBubble, media URLs
    Feed.tsx, VideoCard.tsx, VideoPlayer.tsx, UploadWizard.tsx,
    CommentsSheet.tsx, ShareDialog.tsx, ProfileEditor.tsx, ReportDialog.tsx, VideoGrid.tsx
  hooks/               useAuth, useFeed, useIntersection, useUsernameCheck, useDebounce
  lib/
    supabase/          client (browser), server (RLS-scoped), admin (service-role, server only)
    api-errors.ts      ApiError + handleRoute wrapper for all routes
    auth.ts            getSessionUser / requireProfile
    db.ts              typed row shapes + enrichVideos / fetchVisibleProfiles
    profile-reads.ts   getVisibleProfileByUsername, getProfileCounts
    video-reads.ts     getViewableVideo (shared visibility rule)
    video-hashtags.ts  syncVideoHashtags (server-side tag extraction)
    media.ts           public URLs + resolveVideoUrl (via /api/videos/[id]/stream)
    rate-limit.ts      in-memory per-IP/per-user limiters
    realtime.ts        Supabase realtime subscriptions (inbox, messages)
    validation.ts      zod schemas + hashtag extraction
    config.ts          branding + upload limits (single source of truth)
  middleware.ts        refreshes the Supabase session on every request
supabase/migrations/  0001-0008: schema, helpers, RLS (46 policies), storage (16 policies)
docs/                 DEPLOYMENT.md, SECURITY.md
```

### API routes (30)

`account`, `admin/moderate`, `admin/reports`, `admin/reports/[id]`,
`admin/stats`, `blocks`, `comments/[id]`, `conversations`,
`conversations/[id]/messages`, `conversations/[id]/read`, `feed`, `follows`,
`hashtags/[tag]`, `notifications`, `notifications/read-all`, `profiles/me`,
`reports`, `search`, `upload/sign`, `users/check-username`,
`users/[username]`, `users/[username]/followers`,
`users/[username]/following`, `users/[username]/videos`, `videos`,
`videos/[id]`, `videos/[id]/comments`, `videos/[id]/like`,
`videos/[id]/stream`.

Playback note: the `videos` storage bucket is private, so browsers cannot
fetch video bytes directly. `GET /api/videos/[id]/stream` enforces the same
visibility rule as the video detail endpoint and returns a short-lived
signed URL — the frontend resolves every playable URL through it, so public
videos play for any viewer (including logged-out users) with no client-side
storage credentials.

## Theming

Brand config lives in `src/lib/config.ts` — change the site name, tagline,
colors, and video limits in one place. Colors are CSS variables under
`data-theme` (`dark` default, `light` supported); see `src/app/globals.css`.

## Deployment

See `docs/DEPLOYMENT.md` for the full step-by-step: Supabase project setup,
migrations, storage buckets, env vars, and Vercel deploy. `docs/SECURITY.md`
documents the RLS model, threat model, and a manual security test checklist.

## Current status

The codebase is complete and verified locally (typecheck, lint, build, and
26/26 unit tests pass). It is **not deployed** and has **no live backend**
yet: creating the Supabase project, running the migrations, and deploying
are your steps — see `HANDOFF.md` for the exact checklist and
`docs/DEPLOYMENT.md` for the walkthrough.
