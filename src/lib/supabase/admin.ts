import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. SERVER ONLY.
 *
 * Bypasses Row Level Security entirely. Import this module only from Route
 * Handlers (never from client components), and only after an explicit
 * server-side authorization check. Legitimate uses in this codebase:
 *   - storage object deletes on video removal (owner verified first)
 *   - signed upload URL generation for a server-computed storage path
 *   - account deletion via auth.admin (user confirmed first)
 *   - admin moderation endpoints (is_admin() verified first)
 *
 * Throws at import time in the browser and when the key is missing, so a
 * misconfigured deploy fails loudly instead of silently running unprivileged.
 */

if (typeof window !== "undefined") {
  throw new Error(
    "supabase/admin must never be imported in browser code: it holds the service-role key."
  );
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL. Copy .env.example to .env.local."
  );
}

if (!serviceRoleKey) {
  throw new Error(
    "Missing SUPABASE_SERVICE_ROLE_KEY. This key is server-only: add it to " +
      ".env.local (never commit it, never expose it to the browser)."
  );
}

export const adminClient = createSupabaseClient(supabaseUrl, serviceRoleKey, {
  auth: {
    // The admin client is short-lived per request path; never persist sessions.
    persistSession: false,
    autoRefreshToken: false,
  },
});
