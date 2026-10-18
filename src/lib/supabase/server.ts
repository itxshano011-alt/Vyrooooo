import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Per-request server Supabase client for Server Components and Route
 * Handlers.
 *
 * Runs with the caller's JWT, so Row Level Security policies enforce
 * authorization exactly as defined in supabase/migrations/0008. This is the
 * client to reach for on every user-scoped read and write.
 *
 * The auth session is refreshed by src/middleware.ts on every request; this
 * helper only reads/writes the session cookies.
 */
export async function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copy .env.example to .env.local and fill in your Supabase project values."
    );
  }

  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // Route Handlers may call this after the response has started;
        // the documented @supabase/ssr pattern is to swallow that case.
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Session refresh already happened in middleware; safe to ignore.
        }
      },
    },
  });
}
