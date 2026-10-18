"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { ProfileWithCounts } from "@/lib/db";
import { apiRequest } from "@/lib/api-client";

/**
 * Auth state for the app shell and all pages.
 *
 * AuthContext value:
 *   user: Supabase User | null (the auth session user)
 *   profile: the viewer's ProfileWithCounts (from GET /api/profiles/me) | null
 *   loading: true until the initial session + profile resolve
 *   refreshProfile(): re-fetch the profile (e.g. after ProfileEditor saves)
 *   signOut(): supabase signOut + clear local state
 *
 * Usage: wrap the (main) layout (and any page needing auth) in
 * <AuthProvider>, then const { user, profile, loading } = useAuth().
 */

interface AuthContextValue {
  user: User | null;
  profile: ProfileWithCounts | null;
  loading: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<ProfileWithCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);

  const loadProfile = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<{ profile: ProfileWithCounts }>("/api/profiles/me");
      setProfile(data.profile);
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const sessionUser = data.session?.user ?? null;
      setUser(sessionUser);
      if (sessionUser) {
        await loadProfile();
      }
      if (!cancelled) setLoading(false);
    })();

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const sessionUser = session?.user ?? null;
      setUser(sessionUser);
      if (sessionUser) {
        await loadProfile();
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [supabase, loadProfile]);

  const refreshProfile = useCallback(async () => {
    await loadProfile();
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  }, [supabase]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, profile, loading, refreshProfile, signOut }),
    [user, profile, loading, refreshProfile, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** Helper: login-required redirect target for protected actions. */
export function loginRedirect(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}
