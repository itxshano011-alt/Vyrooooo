import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client for client components.
 *
 * Uses only the public URL and anon key, so it is safe to bundle.
 * Never import the service-role (admin) client into browser code.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copy .env.example to .env.local and fill in your Supabase project values."
    );
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
