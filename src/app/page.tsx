import Link from "next/link";
import { config } from "@/lib/config";

/**
 * VYRO landing page: brand hero, feature highlights, sign-up / log-in CTAs,
 * a CSS-built phone mockup, and a footer. No fake stats anywhere.
 */
export default function LandingPage() {
  const features = [
    {
      title: "Short video, first",
      description:
        "A full-screen feed built for vertical video. For You, Following, and Latest — no clutter, just watch.",
    },
    {
      title: "Create in seconds",
      description:
        "Upload from your camera roll or record right in the browser. Add a caption, hashtags, and publish.",
    },
    {
      title: "Real conversations",
      description:
        "Comments on every video and a private messenger for the people you actually want to talk to.",
    },
    {
      title: "Your space, your rules",
      description:
        "Private accounts, blocking, and reporting keep your corner of VYRO under your control.",
    },
  ];

  return (
    <main className="min-h-dvh bg-surface text-ink">
      {/* Nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <span className="bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] bg-clip-text text-2xl font-black tracking-tight text-transparent">
          {config.siteName}
        </span>
        <nav className="flex items-center gap-3" aria-label="Account">
          <Link
            href="/login"
            className="rounded-xl px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-elevated"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-xl bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] px-5 py-2 text-sm font-bold text-white hover:opacity-90"
          >
            Sign up
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-10 md:grid-cols-2 md:pt-16">
        <div>
          <h1 className="text-4xl font-black leading-tight tracking-tight md:text-6xl">
            {config.tagline.split(".").filter(Boolean).map((part, i, arr) => (
              <span key={part}>
                {part.trim()}
                {i < arr.length - 1 ? ". " : ""}
                {i === 0 && <br aria-hidden="true" />}
              </span>
            ))}
          </h1>
          <p className="mt-5 max-w-md text-lg text-ink-muted">
            VYRO is a short-video platform for creators and the people who love
            them. Watch what moves you, post what moves others, and message
            your people — all in one place.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="rounded-xl bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] px-8 py-3 text-base font-bold text-white hover:opacity-90"
            >
              Get started
            </Link>
            <Link
              href="/home"
              className="rounded-xl border border-border bg-surface-elevated px-8 py-3 text-base font-bold text-ink hover:border-[var(--color-brand-blue)]"
            >
              Explore videos
            </Link>
          </div>
        </div>

        {/* CSS phone mockup */}
        <div className="flex justify-center" aria-hidden="true">
          <div className="relative h-[560px] w-[280px] rounded-[2.5rem] border-[10px] border-surface-elevated bg-black shadow-2xl">
            <div className="absolute left-1/2 top-2 h-6 w-24 -translate-x-1/2 rounded-full bg-surface-elevated" />
            <div className="flex h-full flex-col justify-between overflow-hidden rounded-[1.8rem] bg-gradient-to-b from-[#1a2140] via-[#0b0e17] to-black p-4 pt-10">
              <div>
                <div className="mx-auto h-24 w-24 rounded-full bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))]" />
                <div className="mx-auto mt-4 h-3 w-32 rounded-full bg-surface-elevated" />
                <div className="mx-auto mt-2 h-3 w-20 rounded-full bg-surface-elevated" />
              </div>
              <div className="flex items-end justify-between">
                <div className="flex flex-col gap-2">
                  <div className="h-3 w-36 rounded-full bg-surface-elevated" />
                  <div className="h-3 w-24 rounded-full bg-surface-elevated" />
                </div>
                <div className="flex flex-col gap-3">
                  <div className="h-10 w-10 rounded-full bg-surface-elevated" />
                  <div className="h-10 w-10 rounded-full bg-surface-elevated" />
                  <div className="h-10 w-10 rounded-full bg-surface-elevated" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border bg-surface-elevated/40" aria-labelledby="features-heading">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 id="features-heading" className="text-2xl font-black md:text-3xl">
            Built for how you actually use it
          </h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((f) => (
              <article
                key={f.title}
                className="rounded-2xl border border-border bg-surface p-6"
              >
                <h3 className="font-bold">{f.title}</h3>
                <p className="mt-2 text-sm text-ink-muted">{f.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h2 className="text-3xl font-black">Your first video is one tap away</h2>
        <p className="mx-auto mt-3 max-w-md text-ink-muted">
          Create an account, follow creators you like, and start posting.
        </p>
        <Link
          href="/signup"
          className="mt-8 inline-block rounded-xl bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] px-10 py-3 text-base font-bold text-white hover:opacity-90"
        >
          Sign up free
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
          <span className="bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] bg-clip-text text-lg font-black text-transparent">
            {config.siteName}
          </span>
          <p className="text-sm text-ink-muted">{config.tagline}</p>
          <nav className="flex gap-4 text-sm text-ink-muted" aria-label="Footer">
            <Link href="/login" className="hover:text-ink">Log in</Link>
            <Link href="/signup" className="hover:text-ink">Sign up</Link>
            <Link href="/home" className="hover:text-ink">Explore</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
