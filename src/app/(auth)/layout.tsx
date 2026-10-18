import Link from "next/link";
import { config } from "@/lib/config";

/** Centered card layout shared by the auth pages. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-4 py-10">
      <Link
        href="/"
        className="mb-8 bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] bg-clip-text text-3xl font-black tracking-tight text-transparent"
      >
        {config.siteName}
      </Link>
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface-elevated p-6 sm:p-8">
        {children}
      </div>
      <p className="mt-6 text-center text-sm text-ink-muted">{config.tagline}</p>
    </main>
  );
}
