"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";

const schema = z.object({
  email: z.email("Enter a valid email address"),
});

/** Request a password-reset email. The link lands on /auth/callback -> /reset-password. */
export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string }>({ resolver: zodResolver(schema) });

  const onSubmit = async (values: { email: string }) => {
    setServerError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(values.email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    if (error) {
      setServerError(error.message);
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-black text-ink">Check your email</h1>
        <p className="mt-3 text-sm text-ink-muted">
          If an account exists for that email, a password-reset link is on its
          way. The link expires after a short time.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block font-semibold text-[var(--color-brand-blue)] hover:underline"
        >
          Back to log in
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-black text-ink">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Enter your account email and we will send you a reset link.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 flex flex-col gap-4" noValidate>
        <div>
          <label htmlFor="fp-email" className="mb-1 block text-sm font-semibold text-ink">
            Email
          </label>
          <Input
            id="fp-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            error={!!errors.email}
            {...register("email")}
          />
          <FieldError message={errors.email?.message} />
        </div>

        {serverError && <FieldError message={serverError} />}

        <Button type="submit" fullWidth loading={isSubmitting}>
          Send reset link
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/login" className="font-semibold text-[var(--color-brand-blue)] hover:underline">
          Back to log in
        </Link>
      </p>
    </div>
  );
}
