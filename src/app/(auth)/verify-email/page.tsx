"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

/** Notice shown after signup when email confirmation is required. */
export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading...</p>}>
      <VerifyEmailNotice />
    </Suspense>
  );
}

function VerifyEmailNotice() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email");

  return (
    <div className="text-center">
      <h1 className="text-2xl font-black text-ink">Verify your email</h1>
      <p className="mt-3 text-sm text-ink-muted">
        We sent a confirmation link to{" "}
        {email ? <span className="font-semibold text-ink">{email}</span> : "your email address"}.
        Click the link to activate your account, then log in.
      </p>
      <p className="mt-2 text-sm text-ink-muted">
        Didn&apos;t get it? Check your spam folder — the link expires after a
        while, and you can sign up again to resend it.
      </p>
      <Link
        href="/login"
        className="mt-6 inline-block rounded-xl bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] px-8 py-2.5 font-bold text-white hover:opacity-90"
      >
        Go to log in
      </Link>
    </div>
  );
}
