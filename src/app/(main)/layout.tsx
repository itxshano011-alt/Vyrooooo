"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { config } from "@/lib/config";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { ToastProvider } from "@/components/ui/Toast";
import { Avatar } from "@/components/ui/Avatar";
import { avatarUrl } from "@/lib/media";
import { createClient } from "@/lib/supabase/client";
import { useMemo } from "react";

/**
 * App shell for the main (signed-in-optional) experience.
 *
 * - Mobile: bottom tab bar (Home, Explore, Create, Inbox, Profile).
 * - Desktop: left sidebar with the same destinations + VYRO logo.
 * - Provides AuthProvider + ToastProvider to everything inside.
 * - Profile tab routes to the viewer's own profile; anonymous users go to /login.
 */

interface NavItem {
  href: string;
  label: string;
  icon: (active: boolean) => React.ReactNode;
}

const icons = {
  home: (active: boolean) => (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10" />
    </svg>
  ),
  explore: (active: boolean) => (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
    </svg>
  ),
  create: (_active: boolean) => (
    <span className="flex h-9 w-14 items-center justify-center rounded-xl bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] text-white">
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path strokeLinecap="round" d="M12 5v14M5 12h14" />
      </svg>
    </span>
  ),
  inbox: (active: boolean) => (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 01-13.16 7.96L3 21l1.05-4.84A9 9 0 1121 12z" />
    </svg>
  ),
};

function useNavItems(): NavItem[] {
  const { profile } = useAuth();
  return [
    { href: "/home", label: "Home", icon: icons.home },
    { href: "/explore", label: "Explore", icon: icons.explore },
    { href: "/create", label: "Create", icon: icons.create },
    { href: "/inbox", label: "Inbox", icon: icons.inbox },
    {
      href: profile ? `/profile/${profile.username}` : "/login",
      label: "Profile",
      icon: () => <ProfileIcon />,
    },
  ];
}

function ProfileIcon() {
  const { profile, loading } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  if (loading) return <span className="h-6 w-6 rounded-full bg-surface-elevated" aria-hidden="true" />;
  return <Avatar src={profile ? avatarUrl(supabase, profile.avatar_path) : null} name={profile?.username} size="sm" />;
}

function NavLink({ item, active, vertical = false }: { item: NavItem; active: boolean; vertical?: boolean }) {
  return (
    <Link
      href={item.href}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-xl px-3 py-2 font-semibold transition-colors ${
        vertical ? "flex-col gap-1 text-[11px] md:flex-row md:text-base" : ""
      } ${active ? "text-ink" : "text-ink-muted hover:text-ink"}`}
    >
      {item.icon(active)}
      <span className={vertical ? "md:inline" : ""}>{item.label}</span>
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();
  const navItems = useNavItems();

  const isActive = (href: string) =>
    href === "/home" ? pathname === "/home" || pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex min-h-dvh bg-surface text-ink">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border px-4 py-6 md:flex">
        <Link
          href="/home"
          className="mb-8 bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] bg-clip-text px-3 text-2xl font-black tracking-tight text-transparent"
        >
          {config.siteName}
        </Link>
        <nav className="flex flex-col gap-1" aria-label="Primary">
          {navItems.map((item) => (
            <NavLink key={item.label} item={item} active={isActive(item.href)} />
          ))}
        </nav>
        <div className="mt-auto px-3">
          {!loading && !user && (
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="w-full rounded-xl bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] px-4 py-2.5 font-bold text-white hover:opacity-90"
            >
              Log in
            </button>
          )}
          <p className="mt-4 text-xs text-ink-muted">{config.tagline}</p>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 pb-20 md:pb-0">{children}</main>

        {/* Mobile bottom nav */}
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-border bg-surface/95 px-2 py-2 backdrop-blur md:hidden"
        >
          {navItems.map((item) => (
            <NavLink key={item.label} item={item} active={isActive(item.href)} vertical />
          ))}
        </nav>
      </div>
    </div>
  );
}

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider>
        <Shell>{children}</Shell>
      </AuthProvider>
    </ToastProvider>
  );
}
