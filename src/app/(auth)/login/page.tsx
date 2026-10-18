"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";

const loginSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginValues = z.infer<typeof loginSchema>;

/**
 * Log in with email + password (Supabase browser client).
 * Redirects to ?next= when present, otherwise /home.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading...</p>}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const linkError = searchParams.get("error");
  const [serverError, setServerError] = useState<string | null>(
    linkError === "link-expired"
      ? "That link expired or was already used. Log in or request a new one."
      : null
  );

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

  const onSubmit = async (values: LoginValues) => {
    setServerError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email.trim(),
      password: values.password,
    });
    if (error) {
      setServerError(
        error.message === "Invalid login credentials"
          ? "Email or password is incorrect."
          : error.message
      );
      return;
    }
    router.push(next && next.startsWith("/") ? next : "/home");
    router.refresh();
  };

  return (
    <div>
      <h1 className="text-2xl font-black text-ink">Welcome back</h1>
      <p className="mt-1 text-sm text-ink-muted">Log in to keep watching and creating.</p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 flex flex-col gap-4" noValidate>
        <div>
          <label htmlFor="login-email" className="mb-1 block text-sm font-semibold text-ink">
            Email
          </label>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            error={!!errors.email}
            {...register("email")}
          />
          <FieldError message={errors.email?.message} />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="login-password" className="block text-sm font-semibold text-ink">
              Password
            </label>
            <Link href="/forgot-password" className="text-sm text-[var(--color-brand-blue)] hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            error={!!errors.password}
            {...register("password")}
          />
          <FieldError message={errors.password?.message} />
        </div>

        {serverError && <FieldError message={serverError} />}

        <Button type="submit" fullWidth loading={isSubmitting}>
          Log in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-muted">
        New to VYRO?{" "}
        <Link href="/signup" className="font-semibold text-[var(--color-brand-blue)] hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
