# VYRO Deployment Guide

> Steps marked with **[YOUR ACCOUNT]** need your own accounts — nothing here
> is provisioned for you yet. I cannot create these for you; each step below
> tells you exactly where to click.

## 1. Create a Supabase project [YOUR ACCOUNT]

1. Go to [supabase.com](https://supabase.com) and sign in / sign up.
2. Click **New project**. Pick a name (e.g. `vyro`), a database password
   (save it somewhere safe), and a region close to your users
   (e.g. South Asia / Southeast Asia).
3. Wait for the project to finish provisioning (a few minutes).
4. Open **Project Settings → API** and copy these three values — you will
   need them in step 4:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** secret key → `SUPABASE_SERVICE_ROLE_KEY`
     (server-only: never paste this into the browser, never commit it).

## 2. Run the database migrations [YOUR ACCOUNT]

The migrations live in `supabase/migrations/` and must run **in numeric
order** (`0001` → `0008`): each file builds on the previous one.

**Option A — SQL Editor (simplest, recommended):**

1. In the Supabase dashboard open **SQL Editor → New query**.
2. Open `supabase/migrations/0001_extensions_and_helpers.sql` from this
   repo, paste the whole file into the editor, and click **Run**.
3. Repeat for `0002`, `0003`, … `0008`, in order. Each should report
   success before you move on.

**Option B — Supabase CLI:**

```bash
npm install -g supabase
supabase link --project-ref <your-project-ref>   # from Project Settings → General
supabase db push
```

If any migration fails, stop and read the error — do not skip files.

## 3. Verify the storage buckets [YOUR ACCOUNT]

**You do not create the buckets manually** — migration `0007` already
created all four:

| Bucket             | Public? | Purpose                                  |
| ------------------ | ------- | ---------------------------------------- |
| `videos`           | No      | Short-video files (private; playback goes through `GET /api/videos/[id]/stream`) |
| `thumbnails`       | Yes     | Video thumbnails                         |
| `avatars`          | Yes     | Profile pictures                         |
| `chat-attachments` | No      | Messenger attachments (participants only)|

To confirm: in the dashboard open **Storage** — you should see exactly
these four buckets. Then open **Storage → Policies** and confirm each
bucket lists its policies (16 storage policies total, from migration
`0007`).

If a bucket is missing, re-run migration `0007` in the SQL Editor.

## 4. Set environment variables [YOUR ACCOUNT]

The app reads exactly these variables (see `.env.example` — it must match
this list):

| Variable                         | Where to get it                          | Public? |
| -------------------------------- | ---------------------------------------- | ------- |
| `NEXT_PUBLIC_SUPABASE_URL`       | Supabase → Project Settings → API        | Yes     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`  | Supabase → Project Settings → API        | Yes     |
| `SUPABASE_SERVICE_ROLE_KEY`      | Supabase → Project Settings → API        | **No — server only** |
| `NEXT_PUBLIC_MAX_VIDEO_MB`       | your choice (default `100`)              | Yes     |
| `NEXT_PUBLIC_MAX_VIDEO_SECONDS`  | your choice (default `180`)              | Yes     |

Locally:

```bash
cp .env.example .env.local
# then fill in the three Supabase values
```

On Vercel: **Project → Settings → Environment Variables** — add the same
five. Never commit `.env.local` to git.

Branding (site name, colors) is **not** an env var — it lives in
`src/lib/config.ts`.

## 5. Deploy to Vercel [YOUR ACCOUNT]

1. Push this repo to GitHub (`git init`, commit, push to a new repo).
2. Go to [vercel.com](https://vercel.com), sign in, click **New Project**,
   and import the repo.
3. Add the environment variables from step 4.
4. Click **Deploy**. Vercel auto-detects the Next.js 15 build
   (`npm run build`).

## 6. Verify the deployment [YOUR ACCOUNT]

1. Open the deployed URL and **sign up** a new user. If email confirmation
   is on (Supabase default), click the link in the email, then log in.
2. Tap **Create**, upload a short video, and publish it.
3. Open the **Home** feed — the video should play inline. (Playback uses
   `GET /api/videos/[id]/stream`, which mints a signed URL server-side.)
4. Open the video page, like it, and leave a comment.
5. Visit another user's profile, tap **Message**, and send a chat message.

## 7. Make yourself an admin (optional) [YOUR ACCOUNT]

Admin rights come from the private `admins` table (no client can write it).
After signing up, run this once in the **SQL Editor** as the project owner:

```sql
INSERT INTO public.admins (user_id)
VALUES ('<your-user-uuid>');
```

Find your user UUID in **Authentication → Users** (click the user, copy
the UID). Then open `/admin` in the app to see the moderation dashboard.

## Rollback

Vercel keeps every deployment: to roll back, open **Deployments** and
promote an earlier build.

## Troubleshooting

- **Build fails with "Missing NEXT_PUBLIC_SUPABASE_URL"** — the env vars
  from step 4 are not set in that environment. This error is deliberate:
  the app refuses to boot misconfigured.
- **Videos upload but don't play** — check the `videos` bucket exists
  (step 3) and that the service-role key is set; the stream endpoint needs
  both.
- **Signup email never arrives** — in Supabase go to
  **Authentication → Providers → Email** and confirm email sending is
  enabled; check spam.
- **"Failed to collect page data" during `next build`** — same cause as
  the first item: missing env vars at build time.
